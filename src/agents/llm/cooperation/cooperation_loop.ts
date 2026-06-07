import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { Communication } from "../../communication/communication.js";
import { PeerKind } from "../../../models/message_injection.js";
import { buildTeamGeometry } from "../../cooperation/geometry.js";
import { createLogger, type Logger } from "../../../utils/logger.js";
import { config } from "../../../config.js";
import type { PeerInbox } from "../../coordination/peer_inbox.js";
import type { PostureAssigner } from "../../cooperation/posture/posture_assigner.js";
import type { PerformanceTracker } from "../../cooperation/posture/performance_tracker.js";
import type { LLMClient } from "../client/llm_client.js";

/**
 * Drives periodic team cooperation rounds for the LLM agent.
 *
 * Each round:
 *  1. Broadcasts a `request_beliefs` message to all sensed friends.
 *  2. Waits COLLECT_WINDOW_MS for `beliefs_report` replies.
 *  3. Samples strategy performance and computes team geometry.
 *  4. Calls `LLMClient.chooseCooperationPosture` so the LLM picks a cooperation posture.
 *  5. Applies the chosen posture via PostureAssigner and records it in PerformanceTracker.
 */
export class CooperationLoop {
    private coordinating = false;
    private lastRound = 0;
    private readonly log: Logger;

    constructor(
        private readonly beliefs: Readonly<Beliefs>,
        private readonly comm: Communication,
        private readonly client: LLMClient,
        private readonly inbox: PeerInbox,
        private readonly postureAssigner: PostureAssigner,
        private readonly performanceTracker: PerformanceTracker,
        private readonly getMissionNote: () => string = () => "",
    ) {
        this.log = createLogger("coordination");
    }

    /**
     * Run one cooperation round. Re-entrant calls are always dropped.
     * Cooldown is skipped when `opts.force` is true (used after an admin mission message).
     */
    async runRound(opts?: { force?: boolean }): Promise<void> {
        const now = Date.now();
        if (this.coordinating) {
            this.log.debug("Coordination round skipped (already running)");
            return;
        }
        if (!opts?.force && now - this.lastRound < config.coordination.cooldownMs) {
            this.log.debug("Coordination round skipped (in cooldown)");
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
            await this.comm.broadcast(PeerKind.RequestBeliefs, {});
            const requestedAt = Date.now();

            // Wait for reports to arrive
            await new Promise<void>(r => setTimeout(r, config.coordination.collectWindowMs));

            const freshReports = this.inbox.freshReportsSince(requestedAt);
            this.log.debug(`Collected ${freshReports.size} fresh report(s), running LLM cooperation pass`);

            this.performanceTracker.sample(freshReports, this.beliefs);
            const performance = this.performanceTracker.format();

            const geometry = buildTeamGeometry(this.beliefs, freshReports);

            // Deterministic short-circuit: on single-file corridors where agents cannot pass
            // each other, relay cooperation is the only productive strategy — skip the LLM.
            if (
                geometry.singleFile &&
                (geometry.spawnDeliverySeparation ?? 0) >= config.coordination.corridorSeparationMin
            ) {
                this.log.debug(
                    `Single-file corridor (sep=${geometry.spawnDeliverySeparation}) — forcing ZONAL_RELAY, skipping LLM`,
                );
                await this.postureAssigner.assignPosture("ZONAL_RELAY", { geometry, reports: freshReports });
                this.performanceTracker.markActive("ZONAL_RELAY");
                return;
            }

            const { posture, bonus } = await this.client.chooseCooperationPosture(
                freshReports, geometry, this.beliefs, this.getMissionNote(), performance,
            );
            const result = await this.postureAssigner.assignPosture(posture, { geometry, reports: freshReports, bonus });
            this.performanceTracker.markActive(posture);
            this.log.debug(`Coordination assignPosture(${posture}) → ${result}`);
        } catch (err) {
            this.log.error("Coordination round failed:", err);
        } finally {
            this.coordinating = false;
        }
    }

    /** Start the periodic cooperation interval. */
    start(): void {
        this.log.debug(`Coordination interval: ${config.coordination.intervalMs}ms`);
        setInterval(() => { void this.runRound(); }, config.coordination.intervalMs);
    }
}
