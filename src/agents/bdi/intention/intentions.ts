import type { Beliefs } from "../belief/beliefs.js";
import type { GeneratedDesires, ClearCrateDesire } from "../../../models/desires.js";
import type { IntentionQueue } from "../../../models/intentions.js";
import type { Position } from "../../../models/position.js";
import { getIntentionQueue } from "../desire/desire_sorter.js";
import { posKey } from "../../../utils/metrics.js";

/**
 * Manages the agent's intention queue an ordered list of desires to pursue,
 * rebuilt each deliberation cycle. 
 * The head of the queue is the active intention, which the executor attempts to plan and act on.
 */
export class Intentions {

    private intentionsQueue: IntentionQueue = [];                       // Ordered list of desires to pursue
    private crateDesires: Map<string, ClearCrateDesire> = new Map();    // Tracked CLEAR_CRATE desires, injected by the planner

    /**
     * Rebuild the intention queue from the provided desires, merging in any tracked crate desires.
     * Called every deliberation cycle by bdi_agent and executor (after a successful move).
     * @param beliefs Current beliefs, used by the sorter for distance-based scoring.
     * @param desires Pre-built desire map (REACH_PARCEL, DELIVER_PARCEL, EXPLORE).
     */
    update(beliefs: Beliefs, desires: GeneratedDesires): void {
        // If no desires and no tracked crate desires, clear the queue and return early.
        if (desires.size === 0 && this.crateDesires.size === 0) {
            this.intentionsQueue = [];
            return;
        }

        // Inject tracked crate desires 
        if (this.crateDesires.size > 0) {
            desires.set("CLEAR_CRATE", [...this.crateDesires.values()]);
        }

        // Rebuild the intention queue with the updated desires and current beliefs.
        this.intentionsQueue = getIntentionQueue(desires, beliefs);
    }

    /**
     * Drop the head of the queue (e.g. after a plan completes or is unrecoverable).
     * If the dropped desire is a CLEAR_CRATE, also removes it from the crateDesires map.
     */
    dropIntentionHead(): void {
        const head = this.intentionsQueue[0];
        // If the head intention is a CLEAR_CRATE desire, remove it from the tracking map.
        if (head?.desire.type === "CLEAR_CRATE") {
            this.crateDesires.delete(posKey(head.desire.target));
        }
        // Remove the head of the queue.
        this.intentionsQueue.shift();
    }

    /**
     * Returns the head intention, or null if the queue is empty.
     * The head intention is the current active desire that the agent is pursuing.
      * @returns The head intention, or null if the queue is empty.
      */
    getIntentionHead(): IntentionQueue[0] | null {
        return this.intentionsQueue.length > 0 ? this.intentionsQueue[0] : null;
    }

    /**
     * Register a CLEAR_CRATE desire for the given target.
     * @param desire The CLEAR_CRATE desire to track, keyed by its target position.
     */
    addCrateDesire(desire: ClearCrateDesire): void {
        const key = posKey(desire.target);
        if (!this.crateDesires.has(key)) {
            this.crateDesires.set(key, desire);
        }
    }

    /**
     * Returns true if a CLEAR_CRATE desire for the given target is already tracked.
     * @param target The target position of the CLEAR_CRATE desire to check.
     * @returns True if a desire for the target is already tracked, false otherwise.
     */
    hasCrateDesireFor(target: Position): boolean {
        return this.crateDesires.has(posKey(target));
    }
}
