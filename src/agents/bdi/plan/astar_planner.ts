import { stepsTo } from "./navigation/a_star.js";
import { CollisionManager } from "./collision/collision_manager.js";
import type { Beliefs } from "../belief/beliefs.js";
import type { Position } from "../../../models/position.js";
import type { DesireType } from "../../../models/desires.js";
import type { Plan, PlanStep } from "../../../models/plan.js";

/** Terminal steps appended to the path for desires that require a game action on arrival. */
export const TERMINAL_STEP: Partial<Record<DesireType["type"], PlanStep>> = {
    REACH_PARCEL: { kind: "pickup" },
    DELIVER_PARCEL: { kind: "putdown" },
};

/**
 * A* planner for single-target navigation desires.
 * Owns the CollisionManager and provides path validation and detour logic.
 */
export class AStarPlanner {
    private readonly collision: CollisionManager;

    constructor(private readonly beliefs: Beliefs) {
        this.collision = new CollisionManager(
            (from, intention, blockedTile) => this.plan(from, intention, blockedTile),
            beliefs,
        );
    }

    /**
     * Plan a path from `from` to `intention.target`, optionally avoiding a blocked tile.
     * @param from Starting position.
     * @param intention The navigation desire, which determines the target and any terminal step.
     * @param blockedTile An extra tile to avoid during this search, or null.
     * @returns A Plan, or null if no valid path exists.
     */
    plan(from: Position, intention: DesireType, blockedTile: Position | null = null): Plan | null {
        const steps = stepsTo(this.beliefs, from, intention.target, blockedTile);
        if (!steps) return null;

        const terminal = TERMINAL_STEP[intention.type];
        if (terminal) steps.push(terminal);
        return steps.length > 0 ? { source: "astar", steps, cursor: 0, target: intention } : null;
    }

    /**
     * Get the next step from the plan, attempting a detour if the tile is blocked by another agent.
     * @param plan The current plan being executed.
     * @param currentPosition The agent's current position.
     * @returns The next step, "wait" if blocked, or null if the plan is invalid or complete.
     */
    nextStep(plan: Plan, currentPosition: Position): PlanStep | "wait" | null {
        const step = plan.steps[plan.cursor];
        if (!step) return null;
        if (step.kind !== "move") return step;

        const walkable = (a: Position, b: Position) => this.beliefs.map.isWalkable(a, b);
        if (!this.beliefs.agents.isNextBlockedByAgents(step.to, walkable)) {
            // We outrank this friend, so isNextBlockedByAgents waved us through — but it is
            // physically on our next tile. Wait for it to vacate instead of ramming the tile
            // (which would fail and escalate to mark-blocked + replan). Keeps our path; the
            // lower-id friend is the one that yields and replans around.
            if (this.beliefs.agents.isTileHeldByOutrankedFriend(step.to)) return "wait";
            return step;
        }

        if (this.collision.tryDetour(plan, currentPosition, step.to)) {
            return plan.steps[plan.cursor] ?? null;
        }

        const decision = this.collision.onPreDetection(step.to);
        if (decision.kind === "wait") return "wait";

        if (!this.collision.commitBlocked(plan, currentPosition, step.to, decision.ttl)) {
            plan.steps = [];
        }
        return plan.steps[plan.cursor] ?? null;
    }

    /**
     * Advance the plan cursor and reset collision state.
     * @returns true if the plan is now complete.
     */
    advance(plan: Plan): boolean {
        plan.cursor++;
        this.collision.reset();
        return plan.cursor >= plan.steps.length;
    }

    /**
     * Invalidate a move failure: consult the collision manager and optionally mark the tile as blocked.
     * @returns true if the plan should be considered invalidated.
     */
    invalidate(plan: Plan): boolean {
        const step = plan.steps[plan.cursor];
        if (!step || step.kind !== "move") return false;

        const decision = this.collision.onMoveFailure(step.to);
        if (decision.kind === "block") {
            this.beliefs.map.markBlocked(step.to, decision.ttl);
            this.collision.reset();
        }
        return true;
    }

    /**
     * Validate that the remaining move steps are still walkable from `currentPosition`.
     * @returns true if all remaining steps can still be executed.
     */
    validate(plan: Plan, currentPosition: Position): boolean {
        let cur = currentPosition;
        for (let i = plan.cursor; i < plan.steps.length; i++) {
            const step = plan.steps[i];
            if (step.kind !== "move") continue;
            if (!this.beliefs.map.isWalkable(cur, step.to)) return false;
            cur = step.to;
        }
        return true;
    }

    /**
     * Reset the planner's collision state.
     */
    reset(): void {
        this.collision.reset();
    }
}
