import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Beliefs } from "../belief/beliefs.js";
import type { ClearCrateDesire } from "../../../models/desires.js";
import type { Plan, PlanStep } from "../../../models/plan.js";
import type { Position } from "../../../models/position.js";
import { buildProblem } from "./pddl/problem_builder.js";
import { parsePddlPlan, parsePlanString } from "./pddl/response_parser.js";
import { localSolver } from "./pddl/solver.js";

const CRATE_DOMAIN_PATH = join(dirname(fileURLToPath(import.meta.url)), "pddl", "domain-crates.pddl");
/**
 * PDDL planner for generating plans to clear crates blocking the agent's path.
 * Requests are asynchronous: `plan()` kicks off a solver request and returns null until ready,
 * then returns the ready plan on subsequent calls without consuming it.
 * The orchestrator explicitly calls `consumeReady()` when it decides to use the plan.
 */
export class PddlPlanner {
    private inFlight = false;
    private ready: Plan | null = null;
    private readonly domain: string;

    constructor(private readonly beliefs: Beliefs) {
        this.domain = readFileSync(CRATE_DOMAIN_PATH, "utf8");
    }

    /**
     * Return the ready plan if available, or kick off a solver request if neither ready nor in-flight.
     * Does not consume the ready plan — call `consumeReady()` explicitly when the plan is accepted.
     * @param desire The CLEAR_CRATE desire to plan for.
     * @returns The ready plan (not consumed), or null if still computing.
     */
    plan(desire: ClearCrateDesire): Plan | null {
        if (this.ready) return this.ready;
        if (!this.inFlight) this.startRequest(desire);
        return null;
    }

    /**
     * Consume and clear the ready plan. Call this once the orchestrator has decided to use it.
     * @returns The ready plan, or null if none is available.
     */
    consumeReady(): Plan | null {
        return this.ready;
    }

    /**
     * Compute the tile the agent must stand on before the first move of `plan`.
     * Used by the orchestrator to determine whether a REACH_POINT bridge is needed.
     * @returns The expected start position, or null if the plan starts with a non-move step.
     */
    getExpectedStart(plan: Plan): Position | null {
        const firstStep = plan.steps[plan.cursor];
        if (!firstStep || firstStep.kind !== "move") return null;
        const deltas: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [1, 0], right: [-1, 0] };
        const [dx, dy] = deltas[firstStep.direction] ?? [0, 0];
        return { x: firstStep.to.x + dx, y: firstStep.to.y + dy };
    }

    /**
     * Returns true if a solver request is currently in-flight.
     */
    isWaiting(): boolean { return this.inFlight; }

    /**
     * Validate a PDDL plan. PDDL plans are trusted until explicitly invalidated.
     */
    validate(_plan: Plan, _from: Position): boolean { 
        // If the desire target doesn't exist on the map anymore, the plan is invalid. 
        return true;
    }

    /**
     * Get the next step from the plan. Returns null if the tile is blocked; the orchestrator
     * then invalidates the plan (no detour attempt for PDDL plans).
     * @param plan The PDDL plan being executed.
     * @param currentPosition The agent's current position.
     * @returns The next step, or null if blocked or exhausted.
     */
    nextStep(plan: Plan, currentPosition: Position): PlanStep | "wait" | null {
        const step = plan.steps[plan.cursor];
        if (!step) return null;

        // If the current position doesn't match the expected position for this step, invalidate the plan. 
        if(step.kind === "move") {
            const expectedStart = this.getExpectedStart(plan);
            if (!expectedStart || expectedStart.x !== currentPosition.x || expectedStart.y !== currentPosition.y) {
                return null;
            }
        }

        return step;
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
     * Invalidate a PDDL plan — resets all internal state so a new request can be made.
     * @returns true, indicating the plan should be cleared by the orchestrator.
     */
    invalidate(_plan: Plan): boolean {
        this.reset();
        return true;
    }

    /**
     * Clear all planner state. Called on plan completion or invalidation.
     */
    reset(): void {
        this.inFlight = false;
        this.ready = null;
    }

    /**
     * Start a solver request for the given desire. Sets in-flight state and updates ready state on completion.
     * @param desire The desire to generate a plan for.
     */
    private startRequest(desire: ClearCrateDesire): void {
        this.inFlight = true;
        this.generatePlan(desire)
            .then(plan => { this.inFlight = false; this.ready = plan; })
            .catch(() => { this.inFlight = false; });
    }

    /**
     * Generate a plan for the given desire by building a PDDL problem and sending it to the solver.
     * @param desire The desire to generate a plan for.
     * @returns The generated plan, or null if generation failed.
     */
    private async generatePlan(intention: ClearCrateDesire): Promise<Plan | null> {
        const problem = buildProblem(intention, this.beliefs);
        if (!problem) return null;

        const rawOutput = localSolver(this.domain, problem);

        const steps = parsePddlPlan(parsePlanString(rawOutput));
        if (steps.length === 0) return null;

        const lastStep = steps[steps.length - 1];
        if (lastStep.kind === "move") {
            intention.target = lastStep.to;
        }

        return { source: "pddl", steps, cursor: 0, target: intention };
    }
}
