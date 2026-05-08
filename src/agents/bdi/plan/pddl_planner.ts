import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { onlineSolver } from "@unitn-asa/pddl-client";
import type { Beliefs } from "../belief/beliefs.js";
import type { ClearCrateDesire } from "../../../models/desires.js";
import type { Plan, PlanStep } from "../../../models/plan.js";
import type { Position } from "../../../models/position.js";
import { buildProblem } from "./pddl/problem_builder.js";
import { parsePddlPlan } from "./pddl/response_parser.js";
import { CollisionManager } from "./collision/collision_manager.js";
import { AStarPlanner } from "./astar_planner.js";

// Path to the PDDL domain file for crate clearing, which defines the actions and predicates relevant to moving crates out of the way.
const CRATE_DOMAIN_PATH = join(dirname(fileURLToPath(import.meta.url)), "pddl", "domain-crates.pddl");

/**
 * PDDL planner for generating plans to clear crates that are blocking the agent's path to its current intention's target.
 */
export class PddlPlanner {
    private inFlight = false;               // Indicates whether a PDDL plan request is currently in flight, to prevent multiple simultaneous requests.
    public ready: Plan | null = null;      // Holds the most recently generated PDDL plan that is ready for consumption by the executor, or null if no plan is ready.

    private domain : string;                 // The PDDL domain definition, loaded from the domain file.

    private aStarPlanner: AStarPlanner;   // The A* planner used for generating detour plans when a crate is detected on the path, initialized lazily to avoid circular dependencies.
    private collision : CollisionManager;

    constructor(
        private readonly beliefs: Beliefs
    ) {
        this.domain = readFileSync(CRATE_DOMAIN_PATH, "utf8");
        this.aStarPlanner = new AStarPlanner(beliefs);
        this.collision = new CollisionManager(
            (from, intention, blockedTile) => this.aStarPlanner?.plan(from, intention, blockedTile),
            beliefs,
        );
    }

    /**
     * Plan a sequence of steps to clear the crate(s) blocking the way to the current intention's target, based on the agent's current beliefs about the environment.
     * @param intention The CLEAR_CRATE desire specifying which crate(s) to clear and their target location.
     * @returns A Plan object containing the sequence of steps to clear crates, or null if planning fails.
     */
    async plan(intention: ClearCrateDesire): Promise<Plan | null> {
        // Builds a PDDL problem definition based on the current beliefs and the target of the CLEAR_CRATE desire. 
        const problem = buildProblem(intention, this.beliefs);
        if (!problem) return null;

        // Request to the onlineSolver the path
        const rawPlan = await onlineSolver(this.domain, problem);
        if (!rawPlan?.length) {
            return null;
        }

        // Parse the requested plan
        const steps = parsePddlPlan(rawPlan);
        if (steps.length === 0) return null;

        // Update the intention's target to the final destination after clearing crates
        const lastStep = steps[steps.length - 1];
        if (lastStep.kind === "move") {
            intention.target = lastStep.to; // Update the intention's target to the final destination after clearing crates, which may differ from the original target if the crate was blocking the way.
        }

        return { source: "pddl", steps, cursor: 0, targets: [intention]};
    }

    /**
     * Request a plan asynchronously without blocking. Sets inFlight to true and executes the plan request in the background.
     * @param desire The CLEAR_CRATE desire to plan for.
     * @param onComplete Callback invoked when planning completes, receiving the generated plan or null if planning failed.
     */
    request(desire: ClearCrateDesire, onComplete: (plan: Plan | null) => void): void {
        if (this.inFlight || this.ready) return;
        this.inFlight = true;
        this.plan(desire)
            .then(plan => { this.inFlight = false; this.ready = plan; onComplete(plan); })
            .catch(() => { this.inFlight = false; onComplete(null); });
    }

    /**
     * Retrieve and clear the ready plan. This should be called after request() completes to obtain the result.
     * @returns The ready plan if available, or null; clears ready state after returning.
     */
    consume(): Plan | null {
        const plan = this.ready;
        this.ready = null;
        return plan;
    }

    /**
     * Check if a PDDL plan request is currently in flight.
     * @returns true if a plan request is pending, false otherwise.
     */
    isWaiting(): boolean { return this.inFlight; }

    /**
     * Get the next step from the plan and validate it against the current position. If the agent has drifted from the expected position, the plan is invalidated.
     * If the target position is blocked by other agents, returns "wait" to defer the step.
     * @param plan The plan containing the sequence of steps.
     * @param currentPosition The agent's current position on the map.
     * @returns The next step to execute, "wait" if blocked, or null if the plan is exhausted or invalid.
     */
    nextStep(plan: Plan, currentPosition: Position): PlanStep | "wait" | null {
        const step = plan.steps[plan.cursor];
        if (!step) return null;
        if (step.kind !== "move") return step;

        // Validate that the expected next position is walkable and not blocked by another agent
        const walkable = (a: Position, b: Position) => { return this.beliefs.map.isWalkable(a, b) && this.beliefs.map.isCrateAt(b); };
        if (!this.beliefs.agents.isNextBlockedByAgents(step.to, walkable)) return step;

        // If no detour is possible, consult the collision manager to decide whether to wait or to mark the tile as blocked and trigger replanning.
        const decision = this.collision.onPreDetection(step.to);
        if (decision.kind === "wait") return "wait";

        // If no replacement route exists, drop this plan and let the queue plan again.
        if (!this.collision.commitBlocked(plan, currentPosition, step.to, decision.ttl)) {
            this.reset();
        }
        return null;
    }

    /**
     * Advance the plan cursor to the next step. Resets the planner if the plan is exhausted.
     * @param plan The plan being executed.
     * @returns true if the plan is now complete, false if there are more steps remaining.
     */
    advance(plan: Plan): boolean {
        //#TODO: Update also ready cursor in a smart way in order to avoid flickering
        plan.cursor++;
        return plan.cursor >= plan.steps.length;
    }

    /**
     * Mark a plan as invalid and reset the planner state. Called when the plan can no longer be executed due to environmental changes.
     * @param _plan The plan being invalidated (parameter unused, plan is managed internally).
     * @returns true indicating the planner has been reset.
     */
    invalidate(_plan: Plan): boolean {
        this.reset();
        return true;
    }

    /**
     * Clear all planner state, including in-flight request flag and ready plan. Used after plan execution completes or when invalidating a plan.
     */
    reset(): void {
        this.inFlight = false;
        this.ready = null;
    }
}
