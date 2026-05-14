import type { CollisionDecision, Plan } from "../../../../models/plan.js";
import type { Position } from "../../../../models/position.js";
import type { NavigationDesire } from "../../../../models/desires.js";
import type { Beliefs } from "../../belief/beliefs.js";
import { CollisionTimer } from "./collision_timer.js";

type CollisionPlanner = (
    from: Position,
    intention: NavigationDesire,
    blockedTile?: Position | null,
) => Plan | null;

/**
 * Encapsulates the collision state machine: tracks how long we've been waiting on a specific
 * blocked tile, counts repeated detections, and escalates to a hard block when timer or
 * retry thresholds are exceeded. The caller owns the actual "mark blocked + replan" step.
 */
export class CollisionManager {
    private timer = new CollisionTimer();
    private invalidationCount = 0;

    constructor(private readonly plan: CollisionPlanner, private readonly beliefs: Beliefs) {}

    // Tuning parameters — duration/counter thresholds for the collision escalation flow
    private static readonly DETOUR_THRESHOLD_STEPS = 5;                // Maximum number of steps for a detour to be considered preferable over waiting
    private static readonly BLOCKED_AFTER_EXPIRATION_TTL_MS = 2_000;   // TTL for marking a tile as blocked after waiting for it to clear, or after a failed detour attempt
    private static readonly INVALIDATION_BLOCKED_TTL_MS = 1_000;       // TTL for marking a tile as blocked after repeated failed invalidation attempts
    private static readonly WAIT_MIN_MS = 1_000;                       // Minimum wait time before marking a tile as blocked
    private static readonly WAIT_MAX_MS = 1_500;                       // Maximum wait time before marking a tile as blocked
    private static readonly INVALIDATION_RETRY_LIMIT = 2;              // Number of times to retry invalidating a tile before marking it as blocked in beliefs to avoid getting stuck

    /** Maximum extra steps a detour may add before we prefer to wait instead. */
    get detourThresholdSteps(): number { return CollisionManager.DETOUR_THRESHOLD_STEPS; }

    /** TTL to apply when committing a block after a detour is chosen. */
    get detourCommitTtl(): number { return CollisionManager.BLOCKED_AFTER_EXPIRATION_TTL_MS; }

    /** Clear all collision state (called when the path advances or a block is committed). */
    reset(): void {
        this.timer.reset();
        this.invalidationCount = 0;
    }

    /**
     * Handle a pre-detection of another agent standing on our next tile.
     * Starts a random wait timer on first encounter, counts repeat detections, and
     * escalates to a hard block once either the retry limit or the timer expires.
     */
    onPreDetection(tile: Position): CollisionDecision {
        // If we're not already waiting for this tile, start the collision timer
        if (!this.timer.isWaitingFor(tile)) {
            this.timer.start(tile, CollisionManager.WAIT_MIN_MS, CollisionManager.WAIT_MAX_MS);
        } else {
            // Count each repeated pre-detection for the same tile so the limiter
            // works regardless of whether blocks are caught before or after a move attempt.
            this.invalidationCount++;
        }

        // If the counter exceeds the retry limit, skip the remaining timer and force-mark
        // the tile immediately
        if (this.invalidationCount > CollisionManager.INVALIDATION_RETRY_LIMIT) {
            return { kind: 'block', ttl: CollisionManager.INVALIDATION_BLOCKED_TTL_MS };
        }

        // If the timer hasn't expired yet, we wait before marking the tile as blocked
        if (!this.timer.hasExpired()) {
            return { kind: 'wait' };
        }

        // Once the timer has expired, we consider the tile blocked and commit it in beliefs
        return { kind: 'block', ttl: CollisionManager.BLOCKED_AFTER_EXPIRATION_TTL_MS };
    }

    /**
     * Handle a confirmed move failure for the given tile. Escalates to a hard block
     * as soon as we hit the retry limit; otherwise defers to the pre-detection flow.
     */
    onMoveFailure(tile: Position): CollisionDecision {
        this.invalidationCount++;
        // If we've already tried to invalidate this tile multiple times, we mark it as blocked in beliefs to avoid getting stuck
        if (this.invalidationCount > CollisionManager.INVALIDATION_RETRY_LIMIT) {
            // Mark the tile as blocked with a short TTL to prevent immediate re-selection, then replan
            return { kind: 'block', ttl: CollisionManager.INVALIDATION_BLOCKED_TTL_MS };
        }
        return this.onPreDetection(tile);
    }

    /**
     * Attempt to find a detour around the blocked tile using A*, and splice it into the current plan if it's within the configured threshold compared to waiting.
     * @param plan The current plan that is being executed and may be modified with a detour if needed.
     * @param from The current position of the agent, used as the starting point for the detour A* search.
     * @param blockedTile The tile that is currently blocked by another agent, which the detour should attempt to navigate around.
     * @returns A boolean indicating whether a detour was successfully planned and applied.
     */
    tryDetour(plan: Plan, from: Position, blockedTile: Position): boolean {
        // Check if there is a next step and if it's a move step
        const head = plan.target;
        if (!head) return false; // if there's no target, we can't really detour meaningfully
        if (head.type !== "REACH_PARCEL" && head.type !== "DELIVER_PARCEL" && head.type !== "REACH_POINT") return false; // if the target isn't a location-based desire, we don't have a meaningful way to detour
        
        // Compute a detour plan from the current position to the original plan's next target, treating the blocked tile as an obstacle
        const detourPlan = this.plan(from, head, blockedTile);
        if (!detourPlan) return false;

        // If the detour plan is too long compared to the remaining steps in the original plan, prefer to wait instead to avoid excessive detours
        const remaining = plan.steps.length - plan.cursor;
        if (detourPlan.steps.length > remaining + this.detourThresholdSteps) return false;

        // Splice the detour in place of the remaining steps.
        plan.steps.splice(plan.cursor, plan.steps.length - plan.cursor, ...detourPlan.steps);

        // Mark the blocked tile in beliefs to prevent other plans from trying to walk through it while we execute the detour, with a TTL to allow eventual re-attempts
        this.beliefs.map.markBlocked(blockedTile, this.detourCommitTtl);

        // Reset collision state to avoid interference with the next move attempt after the detour is spliced in
        this.reset();

        // Return true to indicate that a detour was successfully planned and applied to the current plan.
        return true;
    }

    /**
     * Commit a blocked tile in beliefs and replan the current plan around it.
     * Called when the agent decides to treat a tile as blocked after pre-detection or move failure.
     * @param plan The current plan that is being executed and may be modified with a new route if the block is committed.
     * @param from The current position of the agent, used as the starting point for replanning.
     * @param tile The tile to be marked as blocked.
     * @param ttl The time-to-live for the blockage.
     * @returns A boolean indicating whether the blocked tile was successfully committed and the plan was replanned.
     */
    commitBlocked(plan: Plan, from: Position, tile: Position, ttl: number): boolean {
        // Mark the tile as blocked in beliefs to prevent it from being selected in future plans, with the specified TTL
        this.beliefs.map.markBlocked(tile, ttl);
        this.reset();

        // Replan toward the same target with the tile now blocked in beliefs.
        const head = plan.target;
        if (!head) return false;
        if (head.type !== "REACH_PARCEL" && head.type !== "DELIVER_PARCEL" && head.type !== "REACH_POINT") return false;

        // Compute a new plan from the current position to the original plan's next target, with the updated beliefs that include the newly blocked tile
        const replan = this.plan(from, head);
        if (!replan) {
            plan.steps = [];
            return false;
        }

        // Splice the new plan in place of the remaining steps in the original plan, and reset the cursor to the start of the new steps
        plan.steps = replan.steps;
        plan.cursor = 0;
        return true;
    }
}
