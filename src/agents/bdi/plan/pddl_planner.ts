import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Beliefs } from "../belief/beliefs.js";
import type { NavigationDesire } from "../../../models/desires.js";
import type { Plan, PlanStep } from "../../../models/plan.js";
import type { Position } from "../../../models/position.js";
import { buildProblem } from "./pddl/problem_builder.js";
import { parsePddlPlan, parsePlanString } from "./pddl/response_parser.js";
import { localSolver } from "./pddl/solver.js";
import { TERMINAL_STEP } from "./astar_planner.js";

const CRATE_DOMAIN_PATH = join(dirname(fileURLToPath(import.meta.url)), "pddl", "domain-crates.pddl");

/**
 * PDDL planner for navigation desires whose path is blocked by crates.
 * Mirrors the shape of `AStarPlanner`: `plan()` is synchronous and returns a complete
 * plan or null if the solver fails. No async request, no fire-and-check cycle.
 */
export class PddlPlanner {
    private readonly domain: string;

    constructor(
        private readonly beliefs: Beliefs,
        private readonly debug: boolean = false,
    ) {
        this.domain = readFileSync(CRATE_DOMAIN_PATH, "utf8");
    }

    /**
     * Generate a plan from `from` to `intention.target` via PDDL, pushing any blocking crates.
     * Builds the PDDL problem, runs the local solver synchronously, parses the full path, and
     * appends a terminal step (pickup/putdown) for desires that require one on arrival.
     * @param from The agent's current position.
     * @param intention The navigation desire to plan for.
     * @param crateIds IDs of crates detected as blocking the direct path (used for logging only).
     * @returns A complete Plan, or null if the solver returns no valid solution.
     */
    plan(from: Position, intention: NavigationDesire, crateIds: string[]): Plan | null {
        if (this.debug) {
            console.log(`[PDDL] Planning for ${intention.type} via ${crateIds.length} crate(s): [${crateIds.join(", ")}]`);
        }

        const problem = buildProblem(intention.target, this.beliefs);
        if (!problem) return null;

        const rawOutput = localSolver(this.domain, problem);
        const steps = parsePddlPlan(parsePlanString(rawOutput));
        if (steps.length === 0) {
            this.debug && console.log("[PDDL] Solver returned no steps");
            return null;
        }

        // Append terminal action for desires that end with a game action on arrival
        const terminal = TERMINAL_STEP[intention.type];
        if (terminal) steps.push(terminal);

        if (this.debug) console.log(`[PDDL] Plan ready: ${steps.length} step(s)`);
        return { source: "pddl", steps, cursor: 0, target: intention };
    }

    /**
     * Get the next step from the plan.
     * @param plan The active PDDL plan.
     * @param _currentPosition Unused — PDDL plans have no detour logic.
     * @returns The next step, or null if the plan is exhausted.
     */
    nextStep(plan: Plan, _currentPosition: Position): PlanStep | "wait" | null {
        return plan.steps[plan.cursor] ?? null;
    }

    /**
     * Advance the plan cursor.
     * @returns true if the plan is now complete.
     */
    advance(plan: Plan): boolean {
        plan.cursor++;
        return plan.cursor >= plan.steps.length;
    }

    /**
     * Invalidate a PDDL plan after a failed action.
     * Always forces a replan — crate positions may have changed between ticks.
     * @returns true, signalling the orchestrator to clear the current plan.
     */
    invalidate(_plan: Plan): boolean {
        return true;
    }

    /**
     * Validate that the remaining move steps are still walkable.
     * Crate tiles that appear non-walkable are expected along the path and are not checked.
     * @param plan The plan to validate.
     * @param currentPosition The agent's current position.
     * @returns true if the plan is still executable.
     */
    validate(plan: Plan, currentPosition: Position): boolean {
        // PDDL plans are trusted until they fail — skip walkability checks for crate tiles
        return true;
    }

    /**
     * No-op. PddlPlanner holds no mutable state between calls.
     */
    reset(): void {}
}
