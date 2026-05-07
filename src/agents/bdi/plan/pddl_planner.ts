import { onlineSolver } from "@unitn-asa/pddl-client";
import type { Beliefs } from "../belief/beliefs.js";
import type { ClearCrateDesire } from "../../../models/desires.js";
import type { Plan } from "../../../models/plan.js";
import type { Position } from "../../../models/position.js";
import { buildProblem } from "./pddl/problem_builder.js";
import { parsePddlPlan, type PddlPlanStep } from "./pddl/response_parser.js";

/**
 * Submits a crate-clearing problem to the online PDDL solver and returns the resulting plan.
 * Returns null if the solver produces no plan or an empty one.
 */
async function planPddl(
    from: Position,
    intention: ClearCrateDesire,
    beliefs: Beliefs,
    domain: string,
): Promise<Plan | null> {
    // Build the PDDL problem string from the intention and current beliefs
    const problem = buildProblem(intention, beliefs);
    if (!problem) return null;  // map not loaded yet

    const rawPlan = await (onlineSolver as (d: string, p: string) => Promise<PddlPlanStep[] | undefined>)(domain, problem);
    console.log("[PDDL] Solver response received.");
    if (!rawPlan || rawPlan.length === 0) {
        console.warn("[PDDL] No plan returned by solver.");
        return null;
    }

    const steps = parsePddlPlan(rawPlan);
    if (steps.length === 0) return null;

    console.log(`[PDDL] Plan received: ${steps.length} steps.`);
    return { source: "pddl", steps, cursor: 0, targets: [intention], startPosition: from };
}

/**
 * Encapsulates the PDDL solver lifecycle — in-flight flag, ready plan, and domain string.
 * The Planner owns one instance and calls request() when CLEAR_CRATE is at the head.
 * The onComplete callback fires when the solver responds so the agent can deliberate immediately
 * without a polling loop.
 */
export class PddlPlanner {
    private inFlight = false;
    private ready: Plan | null = null;

    constructor(private readonly domain: string) {}

    /** True while the solver HTTP call is in progress. */
    isWaiting(): boolean { return this.inFlight; }

    /**
     * Consume the completed plan and clear the ready slot.
     * Returns null if no plan is ready yet.
     */
    consume(): Plan | null {
        const plan = this.ready;
        this.ready = null;
        return plan;
    }

    /**
     * Submit a crate-clearing problem to the solver. No-op if a request is already in flight.
     * On completion, stores the plan in `ready` and calls onComplete so the agent can
     * deliberate immediately — regardless of whether a sensing event fires.
     * @param onComplete Called with the resulting plan (null on failure).
     */
    request(
        desire: ClearCrateDesire,
        beliefs: Beliefs,
        onComplete: (plan: Plan | null) => void,
    ): void {
        const me = beliefs.agents.getCurrentMe();
        if (!me?.lastPosition) {
            console.warn("[PDDL] Cannot request plan — agent position unknown.");
            onComplete(null);
            return;
        }
        const from = beliefs.agents.getCurrentMe()?.lastPosition;
        if (!from) {
            console.warn("[PDDL] Cannot request plan — agent position unknown.");
            onComplete(null);
            return;
        }
        if (this.inFlight) return;
        this.inFlight = true;
        planPddl(from, desire, beliefs, this.domain)
            .then(plan => { this.inFlight = false; this.ready = plan; onComplete(plan); })
            .catch(() => { this.inFlight = false; onComplete(null); });
    }

    /** Reset all state — called when a PDDL plan completes or is abandoned. */
    reset(): void {
        this.inFlight = false;
        this.ready = null;
    }
}
