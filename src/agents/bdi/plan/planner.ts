import { AStarPlanner, TERMINAL_STEP } from "./astar_planner.js";
import { PddlPlanner } from "./pddl_planner.js";
import { Intentions } from "../intention/intentions.js";
import { detectCrateBlock, findCrateSegment } from "../belief/modules/utils/crate_block.js";
import { stepsTo } from "./navigation/a_star.js";
import type { Beliefs } from "../belief/beliefs.js";
import type { Position } from "../../../models/position.js";
import type { Plan, PlanStep } from "../../../models/plan.js";
import { posKey } from "../../../utils/metrics.js";
import { createLogger, type Logger } from "../../../utils/logger.js";

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
    private readonly log: Logger;

    private currentPlan: Plan | null = null;

    constructor(
        private readonly intentionManager: Intentions,
        private readonly beliefs: Beliefs,
        agentId?: string,
    ) {
        this.log = createLogger("plan", agentId);
        this.astarPlanner = new AStarPlanner(beliefs);
        this.pddlPlanner = new PddlPlanner(beliefs, agentId);
    }

    /**
     * Return the active plan, reusing it if still valid, or searching for a new one.
     * Returns null when the intention queue is empty or no intention can be planned this cycle.
     */
    async plan(): Promise<Plan | null> {
        const from = this.beliefs.agents.getCurrentMe()?.lastPosition;
        if (!from) return null;

        if (this.canReuse(from)) return this.currentPlan;

        this.currentPlan = await this.findPlannableIntention(from);
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
            this.log.debug(`Plan invalidated (${this.currentPlan.source})`);
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
    private async findPlannableIntention(from: Position): Promise<Plan | null> {
        for (let head = this.intentionManager.getIntentionHead(); head; head = this.intentionManager.getIntentionHead()) {
            const desire = head.desire;
            // Already at target: keep the head (don't drop) and return null so the executor idles
            // until the hold expires or is cancelled via request_resume.
            if (desire.type === "HOLD_TILE" && from.x === desire.target.x && from.y === desire.target.y) {
                return null;
            }

            // Try A* first — fast and sufficient for the common case
            const astarPlan = this.astarPlanner.plan(from, desire);
            if (astarPlan) {
                this.log.debug(`A* plan for ${desire.type} (${astarPlan.steps.length} steps)`);
                return astarPlan;
            }

            // A* failed — check if crates are blocking the route and find the local cluster
            const seg = findCrateSegment(this.beliefs, from, desire.target);
            if (seg) {
                // Try stitched A*/PDDL plan: A* to cluster entry, PDDL clears crates, A* to target.
                // The PDDL maneuver is anchored at entry→exit (not agent position→target), making
                // it independent of where the agent is and enabling cache reuse across re-deliberations.
                const prefix = stepsTo(this.beliefs, from, seg.entry);
                const maneuver = await this.pddlPlanner.solveManeuver(seg);
                if (prefix !== null && maneuver !== null) {
                    const steps = [...prefix, ...maneuver];
                    this.log.debug(`Stitched plan for ${desire.type}: ${prefix.length} prefix + ${maneuver.length} maneuver steps`);
                    return { source: "pddl", steps, cursor: 0, target: desire };
                }
                // Fallback: whole-trip PDDL if stitching fails (e.g. maneuver infeasible from entry)
                this.log.debug(`Stitched plan failed for ${desire.type} — falling back to whole-trip PDDL`);
                const pddlPlan = await this.pddlPlanner.plan(from, desire, seg.clusterCrates.map(c => c.id));
                if (pddlPlan) return pddlPlan;
                this.log.debug(`PDDL failed for ${desire.type} — dropping desire`);
            } else {
                // Push-aware path returned null: every reachable path through crates was via an
                // immovable crate (wall behind it). However, a multi-step corridor case can slip
                // through the single-step pushability check, so try the whole-trip PDDL once as
                // a completeness backstop before dropping — at most 1 extra solve, not a loop.
                const crateIds = detectCrateBlock(this.beliefs, from, desire);
                if (crateIds) {
                    this.log.debug(`Push-aware path failed for ${desire.type} — trying whole-trip PDDL (corridor backstop)`);
                    const pddlPlan = await this.pddlPlanner.plan(from, desire, crateIds);
                    if (pddlPlan) return pddlPlan;
                }
                this.log.debug(`A* failed (no viable crate path) for ${desire.type} — dropping desire`);
            }

            this.intentionManager.dropIntentionHead();
        }

        return null;
    }

    /**
     * Decide whether to keep the current plan for this tick.
     * For PDDL plans: always returns true (sticky), but swaps to A* in place if A* can now
     * reach the current head intention (crates cleared or desire reshuffled to a reachable one).
     * For A* plans: standard check — same head desire type+target and remaining steps walkable.
     */
    private canReuse(from: Position): boolean {
        if (!this.currentPlan) return false;
        const head = this.intentionManager.getIntentionHead()?.desire;
        if (!head) return false;

        // Sticky PDDL: keep the plan, but opportunistically swap to A* if it succeeds.
        if (this.currentPlan.source === "pddl") {
            const astarPlan = this.astarPlanner.plan(from, head);
            if (astarPlan) {
                this.log.debug(`PDDL → A* swap for ${head.type}`);
                this.currentPlan = astarPlan;
            } else {
                this.log.debug(`Holding PDDL plan for ${this.currentPlan.target.type}`);
            }
            return true;
        }

        // A* plan: reuse only when the head desire matches and remaining steps are still walkable.
        const target = this.currentPlan.target;
        if (target.type !== head.type) return false;
        if (posKey(target.target) !== posKey(head.target)) return false;
        if (!this.activePlanner(this.currentPlan).validate(this.currentPlan, from)) return false;

        this.log.debug(`Reusing A* plan for ${target.type}`);
        return true;
    }

    /**
     * Return the sub-planner responsible for executing `plan`.
     */
    private activePlanner(plan: Plan): AStarPlanner | PddlPlanner {
        return plan.source === "pddl" ? this.pddlPlanner : this.astarPlanner;
    }

    /**
     * Mark the current plan as complete and clear the plan slot.
     * A* plans drop the intention head explicitly. PDDL plans do not — the queue
     * head may have reshuffled away from the plan's target, and desires are
     * regenerated from beliefs on every intentions.update() call anyway.
     */
    private completePlan(): void {
        this.log.debug(`Plan complete (${this.currentPlan?.source ?? "?"}, ${this.currentPlan?.target.type ?? "?"})`);
        if (this.currentPlan?.source !== "pddl") this.intentionManager.dropIntentionHead();
        this.currentPlan = null;
    }
}
