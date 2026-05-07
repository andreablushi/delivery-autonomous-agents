import { aStar } from "./navigation/a_star.js";
import { CollisionManager } from "./collision/collision_manager.js";
import type { Beliefs } from "../belief/beliefs.js";
import type { Intentions } from "../intention/intentions.js";
import type { Position } from "../../../models/position.js";
import type { NavigationDesire } from "../../../models/desires.js";
import type { Plan, PlanStep } from "../../../models/plan.js";
import { toMoveSteps } from "./utils/action_mapper.js";
import { manhattanDistance, posKey } from "../../../utils/metrics.js";

// Terminal steps for navigation desires, which are appended to the A* path 
const TERMINAL_STEP: Partial<Record<NavigationDesire["type"], PlanStep>> = {
    REACH_PARCEL: { kind: "pickup" },
    DELIVER_PARCEL: { kind: "putdown" },
};

/**
 * A* planner for single-target navigation desires (REACH_PARCEL and DELIVER_PARCEL).
 * The planner also includes a collision manager that can attempt detours and escalate to PDDL when a crate block is detected.
 * The planner is designed to be reactive to dynamic changes in the environment, such as other agents and crates moving around, which can invalidate the current plan. 
 * It provides methods to validate and advance the plan, and to detect when a plan can no longer be executed due to unexpected obstacles (e.g. crates) and trigger replanning or escalation to PDDL.
 */
export class AStarPlanner {
    private readonly collision: CollisionManager;   // Manages collision events and detour attempts during plan execution.

    constructor(private readonly beliefs: Beliefs) {
        // Collision can ask for detours, but every A* plan still comes from this class.
        this.collision = new CollisionManager(
            (from, intention, blockedTile) => this.plan(from, intention, blockedTile),
            beliefs,
        );
    }

    /**
     * Plans a path from a given position to a target position, considering any blocked tiles.
     * @param from The starting position.
     * @param intention The navigation desire.
     * @param blockedTile The position of the blocked tile, if any.
     * @returns A plan with the steps to reach the target, or null if no valid path exists.
     */
    plan(from: Position, intention: NavigationDesire, blockedTile: Position | null = null): Plan | null {
        const steps = this.stepsTo(from, intention.target, blockedTile);
        if (!steps) return null;

        const terminal = TERMINAL_STEP[intention.type];
        if (terminal) steps.push(terminal);
        return steps.length > 0 ? { source: "astar", steps, cursor: 0, targets: [intention] } : null;
    }

    /**
     * Gets the steps to move from a given position to a target position, considering any blocked tiles.
     * @param from The starting position.
     * @param to The target position.
     * @param blockedTile The position of the blocked tile, if any.
     * @returns An array of steps to reach the target, or null if no valid path exists.
     */
    stepsTo(from: Position, to: Position, blockedTile: Position | null = null): PlanStep[] | null {
        const path = aStar(from, to, (f, t) =>
            !(blockedTile && t.x === blockedTile.x && t.y === blockedTile.y) &&
            this.beliefs.map.isWalkable(f, t)
        );
        return path ? toMoveSteps(from, path) : null;
    }

    /**
     * Gets the path from a given position to a target position, ignoring any crates.
     * @param from The starting position.
     * @param to The target position.
     * @param crateKeys The keys of the crates to ignore.
     * @returns An array of positions representing the path, or null if no valid path exists.
     */
    pathIgnoringCrates(from: Position, to: Position, crateKeys: Set<string>): Position[] | null {
        // Used by PDDL escalation to prove the target is reachable once crates are moved.
        return aStar(from, to, (f, t) => crateKeys.has(posKey(t)) || this.beliefs.map.isWalkable(f, t));
    }

    /**
     * Gets the next step to execute for a given plan, considering the agent's current position and any dynamic obstacles.
     * If the next step is blocked by another agent, it will attempt to find a detour. If a detour is not possible, it will decide whether to wait or to mark the tile as blocked and trigger replanning.
     * @param plan The current plan being executed.
     * @param currentPosition The agent's current position, used to validate the next step and detect drift.
     * @returns The next step to execute, "wait" if the agent should wait due to a temporary block, or null if the plan is invalid or completed.
      */
    nextStep(plan: Plan, currentPosition: Position): PlanStep | "wait" | null {
        const step = plan.steps[plan.cursor];
        if (!step) return null;
        if (step.kind !== "move") return step;

        // Validate that the expected next position is walkable and not blocked by another agent
        const walkable = (a: Position, b: Position) => this.beliefs.map.isWalkable(a, b);
        if (!this.beliefs.agents.isNextBlockedByAgents(step.to, walkable)) return step;

        // If the next step is blocked by another agent, attempt to find a detour around the blocked tile. 
        if (this.collision.tryDetour(plan, currentPosition, step.to)) {
            return plan.steps[plan.cursor] ?? null;
        }

        // If no detour is possible, consult the collision manager to decide whether to wait or to mark the tile as blocked and trigger replanning.
        const decision = this.collision.onPreDetection(step.to);
        if (decision.kind === "wait") return "wait";

        // If no replacement route exists, drop this plan and let the queue plan again.
        if (!this.collision.commitBlocked(plan, currentPosition, step.to, decision.ttl)) {
            plan.steps = [];
        }
        return plan.steps[plan.cursor] ?? null;
    }

    /** Advances the plan cursor to the next step, and resets collision state for the next move attempt. 
     * @param plan The current plan being executed.
     * @returns A boolean indicating whether the plan has been completed after advancing.
     */
    advance(plan: Plan): boolean {
        plan.cursor++;
        this.collision.reset();
        return plan.cursor >= plan.steps.length;
    }

    /**
     * Handles the invalidation of a plan when a move step fails, by consulting the collision manager to determine whether the failure was due to a temporary block.
     * @param plan The current plan being executed that has been invalidated by a move failure.
     * @returns A boolean indicating whether the plan was successfully invalidated and updated based on the collision manager's decision.
     */
    invalidate(plan: Plan): boolean {
        // Only invalidate if the failure was on a move step, otherwise we might be invalidating due to a failed pickup/putdown which is a different failure mode
        const step = plan.steps[plan.cursor];
        if (!step || step.kind !== "move") return false;

        // Consult the collision manager to determine whether the move failure was due to a temporary block, and if so, whether we should wait or mark the tile as blocked
        const decision = this.collision.onMoveFailure(step.to);
        if (decision.kind === "block") {
            this.beliefs.map.markBlocked(step.to, decision.ttl);
            this.collision.reset();
        }
        return true;
    }

    /**
     * Determines whether a given plan can still be executed based on the agent's current position and intentions
     * @param plan The plan to validate for reuse, which includes the original target desire and the remaining steps to execute.
     * @param currentPosition The agent's current position, used to validate that the remaining steps in the plan are still walkable and not blocked by new obstacles.
     * @param intentions The agent's current intentions, used to validate that the plan's original target desire is still relevant and at the head of the queue.
     * @returns A boolean indicating whether the plan can still be executed as is, or if it should be discarded and replanned due to changes in the environment or intentions.
     */
    canReuse(plan: Plan, currentPosition: Position, intentions: Intentions): boolean {
        const head = intentions.getIntentionHead()?.desire;
        const target = plan.targets[0];
        return !!head && !!target &&
            target.type === head.type &&
            posKey(target.target) === posKey(head.target) &&
            this.validate(plan, currentPosition);
    }

    /**
     * Validates that the remaining steps in the plan are still executable based on the agent's current position and beliefs about the environment. 
     * @param plan The current plan being executed, which includes the remaining steps to validate.
     * @param currentPosition The agent's current position, used to validate that the next steps in the plan are still walkable and not blocked by new obstacles.
     * @returns A boolean indicating whether the remaining steps in the plan are still valid and executable based on the current environment, or if they have been invalidated by changes such as new obstacles or blocks.
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
     * Resets the planner's internal state, clearing any cached information or temporary data.
     */
    reset(): void {
        this.collision.reset();
    }
}
