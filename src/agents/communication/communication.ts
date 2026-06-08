import { encode, tryDecode, PeerKind, type PeerInjectionMessage, type PeerInjectionKind } from "../../models/message_injection.js";
import { applyInjection, type InjectionDeps } from "../../models/apply_injection.js";
import { evaluateRendezvousVote, evaluateRedLightVote, evaluateGotoVote, evaluateHandoffVote } from "../bdi/desire/scoring/vote.js";
import type { PeerInbox } from "../coordination/peer_inbox.js";
import type { Beliefs } from "../bdi/belief/beliefs.js";
import type { RuleStore } from "../bdi/desire/rule_store.js";
import type { InjectedDesire } from "../../models/desires.js";
import type { DesireType } from "../../models/desires.js";
import type { GameStrategy } from "../../models/game_strategy.js";
import { createLogger, type Logger } from "../../utils/logger.js";
import { config } from "../../config.js";

/** Extract `roundId` from a proposal args object, defaulting to "" on parse failure. */
function extractRoundId(args: unknown): string {
    const obj = args as Record<string, unknown>;
    return typeof obj.roundId === "string" ? obj.roundId : "";
}

/** Dependencies for handling incoming peer-injection messages. */
export type IncomingDeps = {
    beliefs: Beliefs;
    ruleStore: RuleStore;
    addInjectedDesire: (e: InjectedDesire) => void;
    removeInjectedDesiresByType: (t: DesireType["type"]) => void;
    setGameStrategy: (s: GameStrategy) => void;
    armHandoff?: (bonus: number | undefined, ttlMs: number) => void;
    disarmHandoff?: () => void;
    peerInbox: PeerInbox;
};

/**
 * Peer communication for a BDI agent.
 * Handles all inbound peer-injection messages from configured teammates:
 * - position beacons;
 * - belief requests;
 * - handshake proposals, and goal injections;
 * - votes and belief reports recorded in the PeerInbox.
 *
 * Outbound: send/broadcast peer-injection messages and the position beacon.
 *
 * LLM-specific concerns (mission chat) are handled by LLMCommunication, which extends this class.
 */
export class Communication {
    protected readonly log: Logger;

    constructor(
        protected readonly socket: any,
        protected readonly beliefs: Beliefs,
        agentId?: string,
    ) {
        this.log = createLogger("communication", agentId);
    }

    /** Send a peer-injection message to a specific agent. */
    async send(toId: string, tool: Exclude<PeerInjectionKind, "beliefs_report">, args: Record<string, unknown>): Promise<void> {
        this.log.debug(`send to ${toId}: ${tool}`);
        await this.socket.emitSay(toId, encode({ v: 1, kind: "peer_injection", tool, args }));
    }

    /** Broadcast a peer-injection message to all teammates. */
    async broadcast(tool: Exclude<PeerInjectionKind, "beliefs_report">, args: Record<string, unknown>): Promise<void> {
        const ids = this.beliefs.agents.getTeammateIds();
        if (ids.size === 0) return;
        this.log.debug(`broadcast to ${ids.size} teammate(s): ${tool}`);
        const encoded = encode({ v: 1, kind: "peer_injection", tool, args });
        for (const id of ids) {
            await this.socket.emitSay(id, encoded);
        }
    }

    /** Send a text message to a specific agent. */
    async sayText(toId: string, text: string): Promise<void> {
        this.log.debug(`sayText to ${toId}`);
        await this.socket.emitSay(toId, text);
    }

    /**
     * Listen for incoming peer-injection messages and handle them appropriately:
     * - position_beacon: update beliefs about sender's position.
     * - beliefs_report, *_vote: record in peerInbox.
     * - request_beliefs: reply with beliefs_report.
     * - *_propose: evaluate and reply with the corresponding vote.
     * - other tools: treat as intention injection and apply via applyInjection().
     * @param deps Dependencies needed to handle incoming messages, including beliefs, rule store, and intention management functions.
     */
    start(deps: IncomingDeps): void {
        this.socket.on("msg", async (senderId: string, senderName: string, content: unknown) => {
            this.log.debug(`msg from ${senderName} (${senderId}): "${content}"`);
            
            // Try to decode as PeerInjectionMessage. If it fails, treat as raw text.
            const msg = tryDecode(content);

            if (msg) {
                // Check that the sender is a known teammate before processing any peer-injection messages.
                if (!deps.beliefs.agents.getTeammateIds().has(senderId)) {
                    this.log.debug(`ignoring ${msg.tool} from non-teammate ${senderId}`);
                    return;
                }
                // Handle the peer-injection message based on its tool type.
                switch (msg.tool) {
                    
                    // Position beacons are sent periodically by teammates.
                    // Update the sender's position in beliefs based on the beacon data
                    case PeerKind.PositionBeacon: {
                        const args = msg.args as Record<string, unknown>;
                        const rawPos = args.pos as Record<string, unknown> | null;
                        const pos = (rawPos && typeof rawPos.x === "number" && typeof rawPos.y === "number")
                            ? { x: rawPos.x, y: rawPos.y }
                            : null;
                        deps.beliefs.agents.updateAgentFromBeacon(senderId, senderName, pos);
                        return;
                    }
                    
                    // Votes and belief reports are stored in the peer inbox for the coordinator/negotiator.
                    case PeerKind.BeliefsReport:
                    case PeerKind.RendezvousVote:
                    case PeerKind.RedLightVote:
                    case PeerKind.GotoVote:
                    case PeerKind.HandoffVote:
                        deps.peerInbox.record(senderId, msg);
                        return;
                    
                    // When receiving a beliefs request, reply with the current beliefs report
                    case PeerKind.RequestBeliefs: {
                        const report = deps.beliefs.buildReport();
                        this.log.debug(`reply beliefs_report to ${senderId}`);
                        await this.socket.emitSay(senderId, encode({ v: 1, kind: "peer_injection", tool: PeerKind.BeliefsReport, args: report }));
                        return;
                    }
                    
                    // When receiving a proposal (rendezvous, red light, goto, handoff), evaluate the proposal
                    // using the appropriate function and reply with a vote message indicating acceptance or rejection.
                    case PeerKind.RendezvousPropose: {
                        const accept = evaluateRendezvousVote(deps.beliefs, deps.ruleStore, msg.args);
                        const roundId = extractRoundId(msg.args);
                        this.log.debug(`rendezvous_propose from ${senderName}: accept=${accept} (roundId=${roundId})`);
                        await this.send(senderId, PeerKind.RendezvousVote, { roundId, accept });
                        return;
                    }
                    case PeerKind.RedLightPropose: {
                        const accept = evaluateRedLightVote(deps.beliefs, deps.ruleStore, msg.args);
                        const roundId = extractRoundId(msg.args);
                        this.log.debug(`red_light_propose from ${senderName}: accept=${accept} (roundId=${roundId})`);
                        await this.send(senderId, PeerKind.RedLightVote, { roundId, accept });
                        return;
                    }
                    case PeerKind.GotoPropose: {
                        const accept = evaluateGotoVote(deps.beliefs, deps.ruleStore, msg.args);
                        const roundId = extractRoundId(msg.args);
                        this.log.debug(`goto_propose from ${senderName}: accept=${accept} (roundId=${roundId})`);
                        await this.send(senderId, PeerKind.GotoVote, { roundId, accept });
                        return;
                    }
                    case PeerKind.HandoffPropose: {
                        const accept = evaluateHandoffVote(deps.beliefs, deps.ruleStore, msg.args);
                        const roundId = extractRoundId(msg.args);
                        this.log.debug(`handoff_propose from ${senderName}: accept=${accept} (roundId=${roundId})`);
                        await this.send(senderId, PeerKind.HandoffVote, { roundId, accept });
                        return;
                    }
                    
                    // For any other peer-injection message types, treat as intention injections and apply via applyInjection()
                    default: {
                        const injDeps: InjectionDeps = {
                            beliefs: deps.beliefs,
                            ruleStore: deps.ruleStore,
                            addInjectedDesire: deps.addInjectedDesire,
                            removeInjectedDesiresByType: deps.removeInjectedDesiresByType,
                            setGameStrategy: deps.setGameStrategy,
                            sourceId: senderId,
                            armHandoff: deps.armHandoff,
                            disarmHandoff: deps.disarmHandoff,
                        };
                        const result = applyInjection(msg.tool, msg.args, injDeps);
                        if ("error" in result) this.log.warn(`injection error (${msg.tool}):`, result.error);
                        return;
                    }

                }
            }
            
            // If the decode fails, treat as raw text message and use the raw message handler (e.g. for mission chat).
            // BDI agents will ignore raw messages, but LLMCommunication overrides the handler to forward to the LLM client.
            if (typeof content === "string" && content.trim() !== "") {
                this.handleRawMessage(senderId, senderName, content);
            }
        });

        setInterval(() => {
            const pos = this.beliefs.agents.getCurrentPosition();
            if (!pos) return;
            void this.broadcast(PeerKind.PositionBeacon, { pos });
        }, config.beliefs.positionBeaconIntervalMs);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    protected handleRawMessage(_senderId: string, _senderName: string, _content: string): void {}
}
