import type { Beliefs } from "../belief/beliefs.js";
import type { DesireType, GeneratedDesires } from "../../../models/desires.js";
import type { IntentionQueue } from "../../../models/intentions.js";
import { getIntentionQueue } from "../desire/desire_sorter.js";
import { generateDesires } from "../desire/desire_generator.js";
import { createLogger, type Logger } from "../../../utils/logger.js";

/**
 * Manages the agent's intention queue — an ordered list of desires to pursue,
 * rebuilt each deliberation cycle.
 * The head of the queue is the active intention, which the executor attempts to plan and act on.
 */
export class Intentions {

    private intentionsQueue: IntentionQueue = [];
    private readonly desireLog: Logger;
    private readonly log: Logger;

    constructor(agentId?: string) {
        this.desireLog = createLogger("desire", agentId);
        this.log = createLogger("intention", agentId);
    }

    /**
     * Rebuild the intention queue from current beliefs.
     * @param beliefs Current beliefs, used by the sorter for distance-based scoring.
     */
    update(beliefs: Beliefs): void {
        const desires = generateDesires(beliefs);

        this.desireLog.debug(
            `Desires generated — ${[...desires.entries()].map(([type, list]) => `${type}:${list.length}`).join(", ") || "none"}`
        );

        if (desires.size === 0) {
            this.intentionsQueue = [];
            this.log.debug("Queue cleared (no desires)");
            return;
        }

        this.intentionsQueue = getIntentionQueue(desires, beliefs);
        const head = this.intentionsQueue[0];
        this.log.debug(
            `Queue rebuilt (${this.intentionsQueue.length} items)` +
            (head ? ` — head: ${head.desire.type} @(${head.desire.target.x},${head.desire.target.y}) score=${head.score.toFixed(2)}` : "")
        );
    }

    /**
     * Drop the head of the queue after a plan completes or is unrecoverable.
     */
    dropIntentionHead(): void {
        const dropped = this.intentionsQueue.shift();
        if (dropped) this.log.debug(`Dropped head: ${dropped.desire.type} @(${dropped.desire.target.x},${dropped.desire.target.y})`);
    }

    /**
     * Returns the head intention, or null if the queue is empty.
     */
    getIntentionHead(): IntentionQueue[0] | null {
        return this.intentionsQueue.length > 0 ? this.intentionsQueue[0] : null;
    }

    /**
     * Returns true if `desire` is present in the current intention queue (by reference).
     * @param desire The desire to search for.
     */
    hasIntention(desire: DesireType): boolean {
        return this.intentionsQueue.some((intention) => intention.desire === desire);
    }
}
