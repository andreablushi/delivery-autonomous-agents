import type { Beliefs } from "../bdi/belief/beliefs.js";
import type { Communication } from "../communication/communication.js";
import type { InjectedDesire } from "../../models/desires.js";
import { PeerKind, type PeerInjectionKind } from "../../models/message_injection.js";
import { parseRendezvousArgs, parseRedLightArgs, parseGotoArgs } from "../../models/injection_args.js";
import { buildRendezvousHolds, buildHolds } from "../cooperation/holds.js";
import { createLogger, type Logger } from "../../utils/logger.js";
import { config } from "../../config.js";
import type { PeerInbox } from "./peer_inbox.js";

/** 
 * Handles proposing coordinated actions to teammates using a two-phase commit protocol implemented via peer injections. 
 * 1. The coordinator sends a proposal injection to the relevant teammates, describing the proposed coordinated action
 * 2. All the teammates evaluate the proposal and respond with a vote injection indicating acceptance or rejection
 * 3. If the coordinator receives acceptance votes from all relevant teammates within a certain time window, it sends a commit injection 
 * otherwise, it sends an abort injection
 */
export class Negotiator {
    private readonly log: Logger;

    constructor(
        private readonly beliefs: Readonly<Beliefs>,
        private readonly comm: Communication,
        private readonly inbox: PeerInbox,
        private readonly addInjectedDesire: (entry: InjectedDesire) => void,
    ) {
        this.log = createLogger("coordination");
    }

    /** Generate a unique round ID for a proposal */
    private newRoundId(prefix: string): string {
        return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    }

    /**
     * Propose a handoff to a specific partner (OPPORTUNISTIC strategy).
     * Runs the 2PC with handoff_propose/vote/commit/abort.
     * On commit: calls `onCommit` so the initiator can set its own PASSER GameStrategy.
     * The commit message carries `commitExtras` (receiver approach coords) in addition to the meet args.
     * @param partnerId  The teammate this agent wants to hand off to.
     * @param meetArgs   The meet tile and reward/ttl to include in both propose and commit.
     * @param commitExtras Extra fields sent only in the commit message (receiver approach coords).
     * @param onCommit   Called after all peers accept, before the commit message is sent.
     */
    async proposeHandoff(
        partnerId: string,
        meetArgs: { meet_x: number; meet_y: number; reward: number; ttl_seconds: number },
        commitExtras: { approach_x: number; approach_y: number },
        onCommit: () => void,
    ): Promise<string> {
        const roundId = this.newRoundId("hp");
        const proposeArgs = { roundId, ...meetArgs };
        const commitArgs  = { roundId, ...meetArgs, ...commitExtras };
        return this.runTwoPhaseCommit({
            label: "Handoff", roundId,
            proposeKind: PeerKind.HandoffPropose,
            commitKind:  PeerKind.HandoffCommit,
            abortKind:   PeerKind.HandoffAbort,
            proposeArgs, commitArgs,
            recipients: [partnerId],
            onCommit,
        });
    }

    /** Propose a goto action to a teammate */
    async proposeGoto(agentId: string, rawArgs: unknown): Promise<string> {
        // Parse and validate the proposal arguments
        const proposal = parseGotoArgs(rawArgs);
        if ("error" in proposal) return JSON.stringify(proposal);
        if (!this.beliefs.map.checkMapBounds(proposal.target_x, proposal.target_y)) return JSON.stringify({ error: "Coordinates out of map bounds" });
        if (!this.beliefs.agents.getTeammateIds().has(agentId)) return JSON.stringify({ error: `Agent ${agentId} is not a known teammate` });
        
        // If validation passes, initiate the two-phase commit protocol with the specified teammate
        const roundId = this.newRoundId("goto");
        return this.runTwoPhaseCommit({
            label: "Goto", roundId,
            proposeKind: PeerKind.GotoPropose, commitKind: PeerKind.GotoCommit, abortKind: PeerKind.GotoAbort,
            proposeArgs: { roundId, target_x: proposal.target_x, target_y: proposal.target_y, reward: proposal.reward, ttl_seconds: proposal.ttl_seconds },
            recipients: [agentId],
            onCommit: () => {},
        });
    }

    /** Propose a rendezvous action */
    async proposeRendezvous(rawArgs: unknown): Promise<string> {
        // Parse and validate the proposal arguments
        const proposal = parseRendezvousArgs(rawArgs);
        if ("error" in proposal) return JSON.stringify(proposal);
        if (!this.beliefs.map.checkMapBounds(proposal.x, proposal.y)) return JSON.stringify({ error: "Coordinates out of map bounds" });
        const from = this.beliefs.agents.getCurrentPosition();
        if (!from) return JSON.stringify({ error: "Agent position not yet known" });
        const center = { x: proposal.x, y: proposal.y };
        
        // Compute the tiles within the rendezvous zone and check if at least one is reachable
        const roundId = this.newRoundId("rdv");
        const selfHolds = buildRendezvousHolds(this.beliefs as Beliefs, from, center, proposal.max_distance, proposal.reward, {
            releaseZone: { center, maxDistance: proposal.max_distance },
            rendezvousId: roundId,
            sourceId: "coordinator",
        });
        if (selfHolds.length === 0) return JSON.stringify({ error: "No reachable tile within rendezvous zone for self" });
        
        // If validation passes, initiate the two-phase commit protocol with all teammates
        return this.runTwoPhaseCommit({
            label: "Rendezvous", roundId,
            proposeKind: PeerKind.RendezvousPropose, commitKind: PeerKind.RendezvousCommit, abortKind: PeerKind.RendezvousAbort,
            proposeArgs: { roundId, x: proposal.x, y: proposal.y, max_distance: proposal.max_distance, reward: proposal.reward },
            onCommit: () => {
                for (const hold of selfHolds) this.addInjectedDesire(hold);
            },
        });
    }

    /** Propose a red light action */
    async proposeRedLight(rawArgs: unknown): Promise<string> {
        // Parse and validate the proposal arguments
        const proposal = parseRedLightArgs(rawArgs);
        if ("error" in proposal) return JSON.stringify(proposal);
        const from = this.beliefs.agents.getCurrentPosition();
        if (!from) return JSON.stringify({ error: "Agent position not yet known" });
        // Compute the tiles that match the proposed axis and parity and check if at least one is reachable
        const selfTiles = (this.beliefs as Beliefs).map.allLineTiles(from, proposal.axis, proposal.parity);
        if (selfTiles.length === 0) return JSON.stringify({ error: "No matching tile reachable for self" });
        
        // If validation passes, initiate the two-phase commit protocol with all teammates
        const roundId = this.newRoundId("rl");
        return this.runTwoPhaseCommit({
            label: "Red light", roundId,
            proposeKind: PeerKind.RedLightPropose, commitKind: PeerKind.RedLightCommit, abortKind: PeerKind.RedLightAbort,
            proposeArgs: { roundId, reward: proposal.reward, ttl_seconds: proposal.ttl_seconds, axis: proposal.axis, parity: proposal.parity },
            onCommit: () => {
                const expiresAt = Date.now() + proposal.ttl_seconds * 1_000;
                const holds = buildHolds(selfTiles, proposal.reward, { sourceId: "coordinator", expiresAt });
                for (const hold of holds) this.addInjectedDesire(hold);
            },
        });
    }

    /**
     * Run the two-phase commit protocol for a proposed coordinated action.
     * This involves sending a proposal injection to the relevant teammates, 
     * waiting for their acceptance votes, and then sending either a commit or abort injection.
     * @param opts The options for the two-phase commit, including the proposal details, the teammates to involve, and the callbacks for commit/abort outcomes
     * @returns A JSON string indicating the result of the proposal (success or failure with reason)
     */
    private async runTwoPhaseCommit(opts: {
        label: string;
        roundId: string;
        proposeKind: Exclude<PeerInjectionKind, "beliefs_report">;
        commitKind: Exclude<PeerInjectionKind, "beliefs_report">;
        abortKind: Exclude<PeerInjectionKind, "beliefs_report">;
        proposeArgs: Record<string, unknown>;
        /** Payload for the commit message. Defaults to `proposeArgs` when omitted. */
        commitArgs?: Record<string, unknown>;
        onCommit: () => void;
        /** Subset of peers to address. Defaults to all teammates. */
        recipients?: string[];
    }): Promise<string> {

        const { label, roundId, proposeKind, commitKind, abortKind, proposeArgs, onCommit } = opts;
        const commitArgs = opts.commitArgs ?? proposeArgs;
        
        // Determine the teammates to involve in the proposal. 
        // If no specific recipients are provided, default to all known teammates.
        const teammateIds = opts.recipients ?? [...this.beliefs.agents.getTeammateIds()];
        if (teammateIds.length === 0) {
            onCommit();
            return JSON.stringify({ ok: true });
        }

        // Record the time the proposal is sent, so we can ignore any votes that arrived before this time
        const proposeSentAt = Date.now();
        // Send the proposal injection to each relevant teammate
        for (const id of teammateIds) {
            await this.comm.send(id, proposeKind, proposeArgs);
        }
        // Wait for the specified commit window to allow teammates time to respond with their votes
        await new Promise<void>(r => setTimeout(r, config.rendezvous.commitWindowMs));

        // If all the relevant teammates accepted the proposal, send a commit 
        // injection to each of them and execute the onCommit callback
        if (this.inbox.allAccepted(teammateIds, roundId, proposeSentAt)) {
            this.log.debug(`${label} ${roundId}: all peers accepted — committing`);
            for (const id of teammateIds) {
                await this.comm.send(id, commitKind, commitArgs);
            }
            onCommit();
            return JSON.stringify({ ok: true });
        } 
        // Otherwise, send an abort injection to each relevant teammate
        else {
            this.log.debug(`${label} ${roundId}: not all peers accepted — aborting`);
            for (const id of teammateIds) {
                await this.comm.send(id, abortKind, { roundId });
            }
            return JSON.stringify({ ok: false, reason: `${label} rejected: not all peers accepted` });
        }
    }
}
