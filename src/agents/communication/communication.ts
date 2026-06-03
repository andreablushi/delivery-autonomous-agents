import { encode, tryDecode, type PeerInjectionMessage, type PeerInjectionKind } from "../../models/message_injection.js";
import { applyInjection, type InjectionDeps } from "../../models/apply_injection.js";
import { evaluateRendezvousVote } from "../bdi/desire/scoring/vote.js";
import type { Beliefs } from "../bdi/belief/beliefs.js";
import type { RuleStore } from "../bdi/desire/rule_store.js";
import type { InjectedIntention } from "../../models/intentions.js";
import type { DesireType } from "../../models/desires.js";
import { createLogger, type Logger } from "../../utils/logger.js";
import { config } from "../../config.js";

type InboundDeps = {
    beliefs: Beliefs;
    ruleStore: RuleStore;
    addInjectedIntention: (e: InjectedIntention) => void;
    removeIntentionsByType: (t: DesireType["type"]) => void;
};

/**
 * Single communication hub for an agent.
 *
 * Owns the socket's `msg` listener, all outbound peer-injection sends, the
 * 2-second position beacon, and optional hooks for LLM-side coordination and
 * mission messages from the admin.
 *
 * Usage:
 *   const comm = new Communication(socket, beliefs, agentId);
 *   comm.start({ beliefs, ruleStore, addInjectedIntention, removeIntentionsByType });
 *   // optionally, in LLMAgent:
 *   comm.onCoordination((id, msg) => coordinator.handleInbound(id, msg));
 *   comm.onMission((id, name, text) => { ... });
 */
export class Communication {
    private readonly log: Logger;
    private coordinationHook: ((senderId: string, msg: PeerInjectionMessage) => void) | null = null;
    private missionHook: ((senderId: string, senderName: string, content: string) => void) | null = null;

    constructor(
        private readonly socket: any,
        private readonly beliefs: Beliefs,
        agentId?: string,
    ) {
        this.log = createLogger("communication", agentId);
    }

    /**
     * Send a peer-injection message to a specific agent.
     * @param toId Recipient agent ID.
     * @param tool Peer-injection tool name (e.g. "request_goto").
     * @param args Arguments for the tool.
     */
    async send(toId: string, tool: Exclude<PeerInjectionKind, "beliefs_report">, args: Record<string, unknown>): Promise<void> {
        this.log.debug(`send to ${toId}: ${tool}`);
        await this.socket.emitSay(toId, encode({ v: 1, kind: "peer_injection", tool, args }));
    }

    /**
     * Send a peer-injection message to every configured teammate (by ID).
     * Uses the static `teammateIds` set, so messages reach teammates even before
     * they have been sensed. No-op when the teammate set is empty (bdi/competitive modes).
     * @param tool Peer-injection tool name.
     * @param args Arguments for the tool.
     */
    async broadcast(tool: Exclude<PeerInjectionKind, "beliefs_report">, args: Record<string, unknown>): Promise<void> {
        const ids = this.beliefs.agents.getTeammateIds();
        if (ids.size === 0) return;
        this.log.debug(`broadcast to ${ids.size} teammate(s): ${tool}`);
        const encoded = encode({ v: 1, kind: "peer_injection", tool, args });
        for (const id of ids) {
            await this.socket.emitSay(id, encoded);
        }
    }

    /**
     * Send a raw text message (e.g. a reply to the mission admin).
     * @param toId Recipient agent ID.
     * @param text Message text.
     */
    async sayText(toId: string, text: string): Promise<void> {
        this.log.debug(`sayText to ${toId}`);
        await this.socket.emitSay(toId, text);
    }

    /**
     * Register a hook for coordination messages (beliefs_report, rendezvous_vote).
     * Called by LLMAgent so the Coordinator can capture these regardless of the
     * MISSION_EMITTER filter.
     */
    onCoordination(fn: (senderId: string, msg: PeerInjectionMessage) => void): void {
        this.coordinationHook = fn;
    }

    /**
     * Register a hook for raw chat messages (e.g. from the mission admin).
     * Called by LLMAgent to forward commands to LLMClient.
     */
    onMission(fn: (senderId: string, senderName: string, content: string) => void): void {
        this.missionHook = fn;
    }

    /**
     * Register the single inbound `msg` listener and start the 2-second position beacon.
     * Call this once after constructing the agent.
     */
    start(deps: InboundDeps): void {
        this.socket.on("msg", async (senderId: string, senderName: string, content: unknown) => {
            this.log.debug(`msg from ${senderName} (${senderId}): "${content}"`);
            const msg = tryDecode(content);

            if (msg) {
                // Position beacon — update friend tracker before teammate filter so agents
                // outside sensing range can be discovered via broadcast.
                if (msg.tool === "position_beacon") {
                    const args = msg.args as Record<string, unknown>;
                    const rawPos = args.pos as Record<string, unknown> | null;
                    const pos = (rawPos && typeof rawPos.x === "number" && typeof rawPos.y === "number")
                        ? { x: rawPos.x, y: rawPos.y }
                        : null;
                    deps.beliefs.agents.updateAgentFromBeacon(senderId, senderName, pos);
                    return;
                }

                // Coordination messages — route to the coordinator hook (LLM side only).
                if (msg.tool === "beliefs_report" || msg.tool === "rendezvous_vote") {
                    this.coordinationHook?.(senderId, msg);
                    return;
                }

                // Belief request — reply immediately with a snapshot.
                if (msg.tool === "request_beliefs") {
                    const report = deps.beliefs.buildReport();
                    this.log.debug(`reply beliefs_report to ${senderId}`);
                    await this.socket.emitSay(senderId, encode({ v: 1, kind: "peer_injection", tool: "beliefs_report", args: report }));
                    return;
                }

                // Rendezvous proposal — vote and reply.
                if (msg.tool === "rendezvous_propose") {
                    const accept = evaluateRendezvousVote(deps.beliefs, deps.ruleStore, msg.args);
                    const rid = typeof (msg.args as Record<string, unknown>).rid === "string"
                        ? (msg.args as Record<string, unknown>).rid as string
                        : "";
                    this.log.debug(`rendezvous_propose from ${senderName}: accept=${accept} (rid=${rid})`);
                    await this.send(senderId, "rendezvous_vote", { rid, accept });
                    return;
                }

                // All other peer-injectable tools — only accept from known teammates.
                if (!deps.beliefs.agents.getTeammateIds().has(senderId)) {
                    this.log.debug(`ignoring ${msg.tool} from non-teammate ${senderId}`);
                    return;
                }
                const injDeps: InjectionDeps = {
                    beliefs: deps.beliefs,
                    ruleStore: deps.ruleStore,
                    addInjectedIntention: deps.addInjectedIntention,
                    removeIntentionsByType: deps.removeIntentionsByType,
                    sourceId: senderId,
                };
                const result = applyInjection(msg.tool, msg.args, injDeps);
                if ("error" in result) this.log.warn(`injection error (${msg.tool}):`, result.error);
                return;
            }

            // Not a peer-injection — forward raw chat to the mission hook (if registered).
            if (typeof content === "string" && content.trim() !== "") {
                this.missionHook?.(senderId, senderName, content);
            }
        });

        // Position beacon — broadcast own position directly to each configured teammate.
        setInterval(() => {
            const pos = this.beliefs.agents.getCurrentPosition();
            if (!pos) return;
            void this.broadcast("position_beacon", { pos });
        }, config.beliefs.positionBeaconIntervalMs);
    }
}
