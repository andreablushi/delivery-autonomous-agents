import type { Beliefs } from "../belief/beliefs.js";
import type { GeneratedDesires, ClearCrateDesire, ReachPointDesire, DesireType } from "../../../models/desires.js";
import type { IntentionQueue } from "../../../models/intentions.js";
import type { Position } from "../../../models/position.js";
import { getIntentionQueue } from "../desire/desire_sorter.js";
import { posKey } from "../../../utils/metrics.js";
import { generateDesires } from "../desire/desire_generator.js";

/**
 * Manages the agent's intention queue — an ordered list of desires to pursue,
 * rebuilt each deliberation cycle.
 * The head of the queue is the active intention, which the executor attempts to plan and act on.
 */
export class Intentions {

    private intentionsQueue: IntentionQueue = [];
    private crateDesires: Map<string, ClearCrateDesire> = new Map();      // Tracked CLEAR_CRATE desires, injected by the planner
    private reachPointDesires: Map<string, ReachPointDesire> = new Map(); // Tracked REACH_POINT desires, injected when bridging to a PDDL plan

    /**
     * Rebuild the intention queue from current beliefs, merging in any tracked crate and reach-point desires.
     * @param beliefs Current beliefs, used by the sorter for distance-based scoring.
     */
    update(beliefs: Beliefs): void {
        const desires = generateDesires(beliefs);

        if (desires.size === 0 && this.crateDesires.size === 0 && this.reachPointDesires.size === 0) {
            this.intentionsQueue = [];
            return;
        }

        if (this.crateDesires.size > 0) {
            desires.set("CLEAR_CRATE", [...this.crateDesires.values()]);
        }

        if (this.reachPointDesires.size > 0) {
            desires.set("REACH_POINT", [...this.reachPointDesires.values()]);
        }

        this.intentionsQueue = getIntentionQueue(desires, beliefs);
    }

    /**
     * Drop the head of the queue (e.g. after a plan completes or is unrecoverable).
     * Also removes tracked reach-point entries for the dropped desire.
     * Does NOT remove CLEAR_CRATE entries from crateDesires — use dropCrateDesire() explicitly
     * so the desire is re-injected on the next update() if it was dropped without being resolved.
     */
    dropIntentionHead(): void {
        const head = this.intentionsQueue[0];
        if (head?.desire.type === "REACH_POINT") {
            this.reachPointDesires.delete(posKey(head.desire.target));
        }
        this.intentionsQueue.shift();
    }

    /**
     * Stop tracking the CLEAR_CRATE desire for `target`.
     */
    dropCrateDesire(): void {
        this.crateDesires.clear();
    }

    /**
     * Returns the head intention, or null if the queue is empty.
     */
    getIntentionHead(): IntentionQueue[0] | null {
        return this.intentionsQueue.length > 0 ? this.intentionsQueue[0] : null;
    }

    hasIntention(desire: DesireType): boolean {
        return this.intentionsQueue.some((intention) => intention.desire === desire);
    }

    /**
     * Register a CLEAR_CRATE desire. No-op if an equivalent desire already exists for this target.
     * @param desire The CLEAR_CRATE desire to track, keyed by its target position.
     */
    addCrateDesire(desire: ClearCrateDesire): void {
        const key = posKey(desire.target);
        if (!this.crateDesires.has(key)) {
            this.crateDesires.set(key, desire);
        }
    }

    /**
     * Returns true if any tracked CLEAR_CRATE desire references any of the provided crate IDs.
     * @param crateIds Array of crate IDs to check for.
     */
    hasCrateDesireFor(crateIds: string[]): boolean {
        const ids = new Set(crateIds);
        for (const desire of this.crateDesires.values()) {
            for (const id of desire.crateIds) {
                if (ids.has(id)) return true;
            }
        }
        return false;
    }

    /**
     * Inject a REACH_POINT desire for the given target tile. No-op if one already exists.
     * Called by the planner when the PDDL plan's start tile differs from the agent's current position.
     * @param target The tile the agent must reach before executing the PDDL plan.
     */
    injectReachPoint(target: Position): void {
        const key = posKey(target);
        if (!this.reachPointDesires.has(key)) {
            this.reachPointDesires.set(key, { type: "REACH_POINT", target });
        }
    }
}
