import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { Communication } from "../../communication/communication.js";
import type { BeliefsReport, PeerInjectionMessage } from "../../../models/message_injection.js";
import type { InjectedIntention } from "../../../models/intentions.js";
import type { LLMClient } from "../client/llm_client.js";
import { parseRendezvousArgs } from "../../../models/injection_args.js";
import { buildTeamGeometry } from "./geometry.js";
import { createLogger, type Logger } from "../../../utils/logger.js";
import { config } from "../../../config.js";

/**
 * Owns the team-coordination loop for the LLM agent.
 *
 * Periodically (or on demand):
 *  1. Broadcasts a `request_beliefs` message to all sensed friends.
 *  2. Waits COLLECT_WINDOW_MS for `beliefs_report` replies.
 *  3. Computes team geometry deterministically.
 *  4. Calls `LLMClient.coordinate` so the LLM assigns roles via `assign_goto`.
 */
export class Coordinator {
    private readonly reports = new Map<string, { report: BeliefsReport; at: number }>();
    private readonly votes = new Map<string, { rid: string; accept: boolean; at: number }>();
    private coordinating = false;
    private lastRound = 0;
    private readonly log: Logger;

    constructor(
        private readonly beliefs: Readonly<Beliefs>,
        private readonly comm: Communication,
        private readonly client: LLMClient,
        private readonly addInjectedIntention: (entry: InjectedIntention) => void,
    ) {
        this.log = createLogger("coordination");
    }

    /**
     * Handle an already-decoded coordination message (beliefs_report or rendezvous_vote).
     * Called by the Communication inbound router via the coordination hook.
     */
    handleInbound(senderId: string, msg: PeerInjectionMessage): void {
        if (msg.tool === "beliefs_report") {
            this.log.debug(`Received beliefs_report from ${senderId}`);
            this.reports.set(senderId, { report: msg.args, at: Date.now() });
        } else if (msg.tool === "rendezvous_vote") {
            const args = msg.args as Record<string, unknown>;
            if (typeof args.rid === "string" && typeof args.accept === "boolean") {
                this.log.debug(`Received rendezvous_vote from ${senderId}: accept=${args.accept} rid=${args.rid}`);
                this.votes.set(senderId, { rid: args.rid, accept: args.accept, at: Date.now() });
            }
        }
    }

    /**
     * Run the two-phase rendezvous commit protocol.
     *
     * Phase 1 — propose: broadcast the rendezvous parameters to all currently-sensed friends.
     * Phase 2 — commit/abort: wait `rendezvous.commitWindowMs` for votes; if every expected peer
     * voted yes and self can reach the zone, broadcast rendezvous_commit and inject the hold locally;
     * otherwise broadcast rendezvous_abort (no-op on peers) and return failure.
     */
    async proposeRendezvous(rawArgs: unknown): Promise<string> {
        const p = parseRendezvousArgs(rawArgs);
        if ("error" in p) return JSON.stringify(p);
        if (!this.beliefs.map.checkMapBounds(p.x, p.y)) return JSON.stringify({ error: "Coordinates out of map bounds" });

        const from = this.beliefs.agents.getCurrentPosition();
        if (!from) return JSON.stringify({ error: "Agent position not yet known" });

        const selfTiles = this.beliefs.map.allRendezvousTiles(from, p.x, p.y, p.max_distance);
        if (selfTiles.length === 0) return JSON.stringify({ error: "No reachable tile within rendezvous zone for self" });

        const teammateIds = [...this.beliefs.agents.getTeammateIds()];
        const rid = `rdv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        if (teammateIds.length === 0) {
            // No peers — self-commit immediately (a rendezvous with oneself)
            this.injectCommittedHold(p, rid, selfTiles);
            return JSON.stringify({ ok: true });
        }

        // Phase 1: broadcast propose
        const proposeArgs = { rid, x: p.x, y: p.y, max_distance: p.max_distance, reward: p.reward };
        const sentAt = Date.now();
        for (const id of teammateIds) {
            await this.comm.send(id, "rendezvous_propose", proposeArgs);
        }

        // Wait for votes
        await new Promise<void>(r => setTimeout(r, config.rendezvous.commitWindowMs));

        // Phase 2: evaluate votes — every expected peer must have voted yes for this rid after sentAt
        const allAccepted = teammateIds.every(id => {
            const vote = this.votes.get(id);
            return vote && vote.rid === rid && vote.accept && vote.at >= sentAt;
        });

        if (allAccepted) {
            this.log.debug(`Rendezvous ${rid}: all peers accepted — committing`);
            const commitArgs = { rid, x: p.x, y: p.y, max_distance: p.max_distance, reward: p.reward };
            for (const id of teammateIds) {
                await this.comm.send(id, "rendezvous_commit", commitArgs);
            }
            this.injectCommittedHold(p, rid, selfTiles);
            return JSON.stringify({ ok: true });
        } else {
            this.log.debug(`Rendezvous ${rid}: not all peers accepted — aborting`);
            for (const id of teammateIds) {
                await this.comm.send(id, "rendezvous_abort", { rid });
            }
            return JSON.stringify({ ok: false, reason: "Rendezvous rejected: not all peers accepted" });
        }
    }

    /** Inject a committed HOLD_TILE for each candidate tile into the LLM agent's intention pool. */
    private injectCommittedHold(
        p: { x: number; y: number; max_distance: number; reward: number },
        rid: string,
        tiles: { x: number; y: number }[],
    ): void {
        for (const tile of tiles) {
            this.addInjectedIntention({
                desire: {
                    type: "HOLD_TILE",
                    target: tile,
                    sourceId: "coordinator",
                    reward: p.reward,
                    releaseZone: { center: { x: p.x, y: p.y }, maxDistance: p.max_distance },
                    rendezvousId: rid,
                },
                sourceId: "coordinator",
            });
        }
    }

    /** Broadcast a `request_beliefs` message to all configured teammates. */
    private async requestBeliefs(): Promise<void> {
        await this.comm.broadcast("request_beliefs", {});
    }

    /**
     * Run one coordination round:
     *  - request beliefs from all friends
     *  - wait for reports
     *  - compute geometry
     *  - invoke the LLM to assign positions
     *
     * Re-entrant calls and calls within COOLDOWN_MS are silently dropped.
     */
    async runRound(): Promise<void> {
        const now = Date.now();
        if (this.coordinating || now - this.lastRound < config.coordination.cooldownMs) {
            this.log.debug("Coordination round skipped (already running or in cooldown)");
            return;
        }
        if (this.beliefs.agents.getTeammateIds().size === 0) {
            this.log.debug("Coordination round skipped (no teammates configured)");
            return;
        }

        this.coordinating = true;
        this.lastRound = now;
        this.log.debug("Starting coordination round");

        try {
            await this.requestBeliefs();
            const requestedAt = Date.now();

            // Wait for reports to arrive
            await new Promise<void>(r => setTimeout(r, config.coordination.collectWindowMs));

            // Collect only reports that arrived after this request was sent
            const freshReports = new Map<string, BeliefsReport>();
            for (const [id, { report, at }] of this.reports) {
                if (at >= requestedAt) freshReports.set(id, report);
            }

            this.log.debug(`Collected ${freshReports.size} fresh report(s), running LLM coordinate pass`);
            const geometry = buildTeamGeometry(this.beliefs, freshReports);
            await this.client.coordinate(freshReports, geometry, this.beliefs, () => void this.runRound());
        } catch (err) {
            this.log.error("Coordination round failed:", err);
        } finally {
            this.coordinating = false;
        }
    }

    /** Start the periodic coordination interval. */
    start(): void {
        this.log.debug(`Coordination interval: ${config.coordination.intervalMs}ms`);
        setInterval(() => { void this.runRound(); }, config.coordination.intervalMs);
    }
}
