import { AStarPlanner } from "./astar_planner.js";
import { PddlPlanner } from "./pddl_planner.js";
import { Intentions } from "../intention/intentions.js";
import { detectCrateBlock, hasCrateOnPath } from "../belief/utils/crate_block.js";
import type { Beliefs } from "../belief/beliefs.js";
import type { Position } from "../../../models/position.js";
import type { Plan, PlanStep } from "../../../models/plan.js";
import type { ClearCrateDesire } from "../../../models/desires.js";
import { posKey } from "../../../utils/metrics.js";

/**
 * Orchestrates plan generation and execution across the A* and PDDL sub-planners.
 * Owns the current active plan and all plan lifecycle transitions (creation, advance, invalidation).
 */
export class Planner {
    private readonly astarPlanner: AStarPlanner;
    private readonly pddlPlanner: PddlPlanner;

    private currentPlan: Plan | null = null;

    constructor(
        private readonly intentionManager: Intentions,
        private readonly beliefs: Beliefs,
    ) {
        this.astarPlanner = new AStarPlanner(beliefs);
        this.pddlPlanner = new PddlPlanner(beliefs);
    }

    /**
     * Generate or return the current plan for the active intention.
     * @returns The active plan, or null if none is available (e.g. PDDL still in-flight).
     */
    plan(): Plan | null {
        const from = this.beliefs.agents.getCurrentMe()?.lastPosition;
        if (!from) return null;
        if (this.canReuse(from)) return this.currentPlan;
        this.currentPlan = this.findPlannableIntention(from);
        return this.currentPlan;
    }

    /**
     * Get the next step of the current plan.
     * @param currentPosition The agent's current position.
     * @returns The next step, "wait" if temporarily blocked, or null if no safe step is available.
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
     * Advance the plan cursor. Completes the plan if the last step was just executed.
     */
    advance(): void {
        if (!this.currentPlan) return;
        if (this.activePlanner(this.currentPlan).advance(this.currentPlan)) this.completePlan();
    }

    /**
     * Invalidate the current plan after a failed action.
     * @returns true always (signals the executor that invalidation was processed).
     */
    invalidate(): boolean {
        if (!this.currentPlan) return true;
        if (this.activePlanner(this.currentPlan).invalidate(this.currentPlan)) {
            this.currentPlan = null;
        }
        return true;
    }

    /**
     * Search the intention queue for the first plannable desire and return its plan.
     * For CLEAR_CRATE, delegates to the PDDL planner (with bridge injection if needed).
     * For navigation desires, uses A* and detects crate blocks on failure.
     * Desires that cannot be planned this call are skipped (not dropped); they remain in
     * the queue so the next intentions.update() cycle can retry them with fresh beliefs.
     */
    private findPlannableIntention(from: Position): Plan | null {

        for (let head = this.intentionManager.getIntentionHead(); head; head = this.intentionManager.getIntentionHead()) {
            const desire = head.desire;

            if (desire.type === "CLEAR_CRATE") {
                // If the CLEAR_CRATE target desire don't exist anymore in the queue, drop the desire
                if (!this.intentionManager.hasIntention(desire)) {
                    this.intentionManager.dropCrateDesire();
                    return null;
                }
                const pddlPlan = this.pddlPlanner.plan(desire);
                if (!pddlPlan) return null; // in-flight or just kicked off — wait
                // Bridge check: if the agent isn't at the PDDL plan's expected start tile, inject a
                // REACH_POINT and return null so the next executor tick picks up the bridge plan.
                const start = this.pddlPlanner.getExpectedStart(pddlPlan);
                if (start && posKey(from) !== posKey(start)) {
                    this.intentionManager.injectReachPoint(start);
                    return null; // bridge is queued; pick it up on the next tick
                }

                return this.pddlPlanner.consumeReady();
            }

            // Navigation desire — try A*
            const plan = this.astarPlanner.plan(from, desire);
            if (plan) return plan;

            // A* failed — detect crate blocks and swap to CLEAR_CRATE if found
            if (desire.type === "REACH_PARCEL" || desire.type === "DELIVER_PARCEL" || desire.type === "EXPLORE") {
                const block = detectCrateBlock(this.beliefs, from, desire);
                if (block) {
                    this.handleCrateBlock(block);
                    this.intentionManager.dropIntentionHead(); // intentional swap: this nav desire is replaced by CLEAR_CRATE
                    continue;
                }
            }

            // Unplannable this cycle — drop from the live queue. The desire will reappear on the
            // next intentions.update() call (nav desires are regenerated from beliefs each cycle).
            this.intentionManager.dropIntentionHead();
        }

        return null;
    }

    /**
     * Register a crate block and kick off a PDDL request if not already in-flight.
     */
    private handleCrateBlock(block: ClearCrateDesire): void {
        if (this.pddlPlanner.isWaiting()) return;
        if (!this.intentionManager.hasCrateDesireFor(block.crateIds)) {
            this.intentionManager.addCrateDesire(block);
        }
        this.pddlPlanner.plan(block); // kicks off request if not already in-flight
    }

    /**
     * Return true if the current plan can still be reused for the current head intention.
     * For A* plans, also validates that the remaining steps are still walkable.
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
     * Return the sub-planner responsible for a given plan.
     */
    private activePlanner(plan: Plan): AStarPlanner | PddlPlanner {
        return plan.source === "pddl" ? this.pddlPlanner : this.astarPlanner;
    }

    /**
     * Drop the head intention and clear the current plan. Resets PDDL state if the plan was from PDDL.
     */
    private completePlan(): void {
        if (this.currentPlan?.source === "pddl") {
            this.intentionManager.dropCrateDesire(); // stop tracking the CLEAR_CRATE desire for this target
            this.pddlPlanner.reset();
        }
        this.intentionManager.dropIntentionHead();
        this.currentPlan = null;
    }
}
