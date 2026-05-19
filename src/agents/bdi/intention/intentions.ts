import type { Beliefs } from "../belief/beliefs.js";
import type { DesireType, GeneratedDesires } from "../../../models/desires.js";
import type { IntentionQueue, PersistentDesireEntry } from "../../../models/intentions.js";
import { getIntentionQueue } from "../desire/desire_sorter.js";
import { generateDesires } from "../desire/desire_generator.js";
import { createLogger, type Logger } from "../../../utils/logger.js";

/**
 * Manages the agent's intention queue — an ordered list of desires to pursue,
 * rebuilt each deliberation cycle.
 * The head of the queue is the active intention, which the executor attempts to plan and act on.
 */
export class Intentions {
    // List of candidate intentions, ordered by priority and score, with the head at index 0.
    private intentionsQueue: IntentionQueue = [];
    // List of persistent desires injected externally (e.g. by an LLM) that should be added to the generated desires each cycle, with expiration.
    private persistentDesires: PersistentDesireEntry[] = [];
    private readonly desireLog: Logger;
    private readonly log: Logger;

    constructor(agentId?: string) {
        this.desireLog = createLogger("desire", agentId);
        this.log = createLogger("intention", agentId);
    }

    /**
     * Adds a persistent desire that will be included in the intention queue each cycle until it expires.
     * @param entry 
     */
    addPersistentDesire(entry: PersistentDesireEntry): void {
        // Remove any existing entry for the same desire (by type and target) to avoid duplicates, then add the new one.
        this.persistentDesires = this.persistentDesires.filter(
            e => !(e.desire.type === entry.desire.type &&
                   e.desire.target.x === entry.desire.target.x &&
                   e.desire.target.y === entry.desire.target.y)
        );
        this.persistentDesires.push(entry);
    }

    /**
     * Removes expired persistent desires from the list. 
     * Should be called at the start of each deliberation cycle before rebuilding the intention queue.
     */
    private prunePersistent(): void {
        const now = Date.now();
        this.persistentDesires = this.persistentDesires.filter(e => e.expiresAt > now);
    }

    /**
     * Rebuild the intention queue from current beliefs plus any live persistent desires.
     * @param beliefs Current beliefs, used by the sorter for distance-based scoring.
     */
    update(beliefs: Beliefs): void {
        this.prunePersistent();
        const desires = generateDesires(beliefs);

        for (const entry of this.persistentDesires) {
            const bucket = (desires.get(entry.desire.type) ?? []) as DesireType[];
            bucket.push(entry.desire);
            desires.set(entry.desire.type, bucket);
        }

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
