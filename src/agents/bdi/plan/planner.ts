import { AStarPlanner } from "./astar_planner.js";
import { PddlPlanner } from "./pddl_planner.js";
import { Intentions } from "../intention/intentions.js";
import { detectCrateBlock } from "../belief/utils/crate_block.js";
import type { Beliefs } from "../belief/beliefs.js";
import type { Position } from "../../../models/position.js";
import type { Plan, PlanStep } from "../../../models/plan.js";
import { posKey } from "../../../utils/metrics.js";

/**
 * Orchestrates plan generation and execution across the A* and PDDL sub-planners.
 * Owns the current active plan and all plan lifecycle transitions (creation, advance, invalidation).
 *
 * Strategy:
 *   1. Try A* for the head intention.
 *   2. If A* fails and crates block the path, fall back to PDDL for the full trip.
 *   3. If neither works, drop the intention and try the next one.
 */
export class Planner {
    private readonly astarPlanner: AStarPlanner;
    private readonly pddlPlanner: PddlPlanner;

    private currentPlan: Plan | null = null;

    constructor(
        private readonly intentionManager: Intentions,
        private readonly beliefs: Beliefs,
        private readonly debug: boolean = false,
    ) {
        this.astarPlanner = new AStarPlanner(beliefs);
        this.pddlPlanner = new PddlPlanner(beliefs, debug);
    }

    /**
     * Return the active plan, reusing it if still valid, or searching for a new one.
     * Returns null when the intention queue is empty or no intention can be planned this cycle.
     */
    plan(): Plan | null {
        const from = this.beliefs.agents.getCurrentMe()?.lastPosition;
        if (!from) return null;

        if (this.canReuse(from)) {
            this.debug && console.log(`[PLANNER] Reusing ${this.currentPlan!.source} plan for ${this.currentPlan!.target.type}`);
            return this.currentPlan;
        }

        this.currentPlan = this.findPlannableIntention(from);
        return this.currentPlan;
    }

    /**
     * Get the next step of the current plan.
     * Completes the plan automatically if the cursor has run past all steps.
     * @param currentPosition The agent's current position.
     * @returns The next step, "wait" if temporarily blocked, or null if no step is available.
     */
    nextStep(currentPosition: Position): PlanStep | "wait" | null {
        if (!this.currentPlan) return null;
        const step = this.activePlanner(this.currentPlan).nextStep(this.currentPlan, currentPosition);
        if (step === null && this.currentPlan.cursor >= this.currentPlan.steps.length) {
            this.completePlan();
        }
        return step;
    }

    /**
     * Advance the plan cursor after a successful action.
     * Completes the plan if the last step was just executed.
     */
    advance(): void {
        if (!this.currentPlan) return;
        if (this.activePlanner(this.currentPlan).advance(this.currentPlan)) this.completePlan();
    }

    /**
     * Invalidate the current plan after a failed action.
     * Delegates to the active sub-planner; clears `currentPlan` if it confirms invalidation.
     * @returns true always (signals the executor that invalidation was processed).
     */
    invalidate(): boolean {
        if (!this.currentPlan) return true;
        if (this.activePlanner(this.currentPlan).invalidate(this.currentPlan)) {
            this.debug && console.log(`[PLANNER] Plan invalidated (${this.currentPlan.source})`);
            this.currentPlan = null;
        }
        return true;
    }

    /**
     * Walk the intention queue looking for the first desire that can be planned this cycle.
     * For each head desire:
     *   - Try A*; return the plan if it succeeds.
     *   - On A* failure, check for crate blocks; if found, try PDDL.
     *   - If neither planner succeeds, drop the head and advance to the next desire.
     * Desires that cannot be planned are dropped; they will reappear on the next
     * `intentions.update()` call since navigation desires are regenerated from beliefs each cycle.
     */
    private findPlannableIntention(from: Position): Plan | null {
        for (let head = this.intentionManager.getIntentionHead(); head; head = this.intentionManager.getIntentionHead()) {
            const desire = head.desire;

            // Try A* first — fast and sufficient for the common case
            const astarPlan = this.astarPlanner.plan(from, desire);
            if (astarPlan) {
                this.debug && console.log(`[PLANNER] A* plan for ${desire.type} (${astarPlan.steps.length} steps)`);
                return astarPlan;
            }

            // A* failed — check if crates are blocking the route
            const crateIds = detectCrateBlock(this.beliefs, from, desire);
            if (crateIds) {
                this.debug && console.log(`[PLANNER] Crate block on ${desire.type} — falling back to PDDL`);
                const pddlPlan = this.pddlPlanner.plan(from, desire, crateIds);
                if (pddlPlan) return pddlPlan;
                this.debug && console.log(`[PLANNER] PDDL failed for ${desire.type} — dropping desire`);
            } else {
                this.debug && console.log(`[PLANNER] A* failed (no crate block) for ${desire.type} — dropping desire`);
            }

            this.intentionManager.dropIntentionHead();
        }

        return null;
    }

    /**
     * Return true if the current plan can still be reused for the current head intention.
     * Reuse is allowed when the head desire matches the plan's target and the sub-planner
     * confirms the remaining steps are still valid.
     */
    private canReuse(from: Position): boolean {
        if (!this.currentPlan) return false;
        const head = this.intentionManager.getIntentionHead()?.desire;
        if (!head) return false;
        const target = this.currentPlan.target;
        if (target.type !== head.type) return false;
        if (posKey(target.target) !== posKey(head.target)) return false;
        return this.activePlanner(this.currentPlan).validate(this.currentPlan, from);
    }

    /**
     * Return the sub-planner responsible for executing `plan`.
     */
    private activePlanner(plan: Plan): AStarPlanner | PddlPlanner {
        return plan.source === "pddl" ? this.pddlPlanner : this.astarPlanner;
    }

    /**
     * Mark the current plan as complete: drop the intention head and clear the plan slot.
     */
    private completePlan(): void {
        this.debug && console.log(`[PLANNER] Plan complete (${this.currentPlan?.source ?? "?"}, ${this.currentPlan?.target.type ?? "?"})`);
        this.intentionManager.dropIntentionHead();
        this.currentPlan = null;
    }
}
