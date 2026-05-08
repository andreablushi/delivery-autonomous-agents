import { AStarPlanner } from "./astar_planner.js";
import { PddlPlanner } from "./pddl_planner.js";
import { Intentions } from "../intention/intentions.js";
import type { Beliefs } from "../belief/beliefs.js";
import type { Position } from "../../../models/position.js";
import type { Plan, PlanStep } from "../../../models/plan.js";
import type { ClearCrateDesire, NavigationDesire } from "../../../models/desires.js";
import { posKey } from "../../../utils/metrics.js";

/**
 * The Planner is responsible for generating and managing the current plan to achieve the agent's active intention.
 * It integrates both the A* planner for navigation and the PDDL planner for complex crate-clearing tasks.
 * The Planner maintains the current plan and provides methods to retrieve the next step, advance the plan, and invalidate it when necessary.
 * It also handles detecting when a crate is blocking a desire and requesting a PDDL plan to clear it.
 */
export class Planner {
    private readonly astarPlanner: AStarPlanner;    // Used for single-target navigation plans
    private readonly pddlPlanner: PddlPlanner;      // Used for plans involving clearing crates

    private currentPlan: Plan | null = null;        // The current active plan, if any. This is the source of truth for the Executor's actions.

    /**
     * @param intentionManager The Intentions manager, used to access the current active intention and update it when plans complete or are invalidated.
     * @param beliefs The agent's beliefs, used for planning and detecting crate blocks.
     * @param onPddlReady A callback to trigger a re-plan when a PDDL plan is ready, since PDDL planning is asynchronous and may take multiple deliberation cycles.
     */
    constructor(
        private readonly intentionManager: Intentions,
        private readonly beliefs: Beliefs,
        private readonly onPddlReady: () => void,
    ) {
        this.astarPlanner = new AStarPlanner(beliefs);
        this.pddlPlanner = new PddlPlanner(beliefs);
    }

    /**
     * Generate a plan for the current active intention, if any.
     * @returns A Plan if one can be generated 
     */
    plan(): Plan | null {  
        const from = this.beliefs.agents.getCurrentMe()?.lastPosition ?? undefined;

        if (!from) return null;

        // If we already have a plan and we're still in the same position, keep it.
        if (this.keepCurrentPlan(from)) return this.currentPlan;

        // Otherwise, we need to generate a new plan for the current intention head. 
        // defer any detected crate blocks until we've checked the head intention, to avoid requesting unnecessary PDDL plans
        let deferredCrateBlock: ClearCrateDesire | null = null;
        for (let head = this.intentionManager.getIntentionHead(); head; head = this.intentionManager.getIntentionHead()) {
            const desire = head.desire;

            // For CLEAR_CRATE desires, we must use the PDDL planner, which may already have a plan ready or in-flight.
            if (desire.type === "CLEAR_CRATE") {
                // Drop the intention and move on to the next one if we no longer detect the crate on the path, to avoid requesting unnecessary PDDL plans for crates that have already been cleared by other agents.
                if (!this.hasCrateOnPath(from, desire.target)) {
                    this.intentionManager.dropIntentionHead();
                    continue;
                }
                this.currentPlan = this.pddlHandler(from, desire);
                // Update the target of the desire as the last step of the plan if provided by the planner
                if (this.currentPlan || this.pddlPlanner.isWaiting()) return this.currentPlan;
                if (this.currentPlan === null) {
                    // If we failed to get a PDDL plan for the head desire, we should drop it and move on to the next one in the queue. 
                    this.intentionManager.dropIntentionHead();
                    continue;
                }
                continue;
            }

            // For navigation desires, we can use the A* planner and check for crate blocks.
            const plan = this.astarPlanner.plan(from, desire);
            if (plan) return (this.currentPlan = plan);

            // If no plan could be found, check if it's because a crate is blocking the way. 
            // If so, request a PDDL plan to clear the crate. We can defer this if the desire is not at the head of the queue, to avoid requesting unnecessary PDDL plans for desires that might get dropped before we get to them.
            const crateBlock = this.detectCrateBlock(desire, from);
            if (crateBlock && (desire.type === "REACH_PARCEL" || desire.type === "DELIVER_PARCEL")) {
                this.requestForBlock(crateBlock);
            } else if (crateBlock) {
                // If it's a navigation desire that's not at the head of the queue, defer the crate block request until we get to it in the queue, to avoid requesting unnecessary PDDL plans
                deferredCrateBlock ??= crateBlock;
            }

            // If we couldn't find a plan for the head desire, we should drop it
            this.intentionManager.dropIntentionHead();
        }
        // If we exit the loop without returning a plan, it means we have no intentions or couldn't plan for any of them.
        // If we detected a crate block for a non-head desire, we can request a PDDL plan for it now.
        if (deferredCrateBlock) this.requestForBlock(deferredCrateBlock);
        return null;
    }

    /**
     * Get the next step of the current plan, if any, and whether we need to wait for a blocked tile to clear.
     * @param currentPosition The agent's current position, used to determine if the next step is blocked by another agent and we need to wait.
     * @returns 
     */
    nextStep(currentPosition: Position): PlanStep | "wait" | null {
        const plan = this.currentPlan;
        if (!plan) return null;

        // If the next step is a move and it's blocked by another agent, return "wait" to indicate we should wait for the tile to clear before
        const step = this.activePlanner(plan).nextStep(plan, currentPosition);


        // If the step is blocked by another agent, we should wait instead of trying to execute it and failing.
        if (step === null && !plan.steps[plan.cursor]) this.currentPlan = null;
        return step;
    }

    /**
     * Advance the plan's cursor to the next step. If the plan is complete after advancing, drop the current intention and clear the plan.
     * @returns true if the plan was successfully advanced, false if there was no plan to advance or if the plan is now complete and should be dropped.
     */
    advance(): void {
        const plan = this.currentPlan;
        if (!plan) return;
        if (this.activePlanner(plan).advance(plan)) this.completePlan();
    }

    /**
     * Invalidate the current plan, e.g. after a failed move or unexpected state change that makes the current plan no longer executable. This will trigger a re-plan on the next execution cycle.
     * @returns true if the current plan was invalidated and cleared, false if there was no plan to invalidate. The Executor should call this when it detects that the current plan can no longer be executed (e.g. due to a failed move or unexpected state change), to trigger a re-plan on the next execution cycle.
     */
    invalidate(): boolean {
        const plan = this.currentPlan;
        if (!plan) return true;
        if (this.activePlanner(plan).invalidate(plan)) this.currentPlan = null;
        return true;
    }

    /**
     * Determine whether we can keep and reuse the current plan based on the agent's current position and the plan's source. We can keep the current plan if:
     * - It's a PDDL plan, since PDDL plans are more expensive to generate and we want to give them more time to execute even if the agent's position changes (e.g. due to executing some of the steps or being pushed by another agent).
     * - It's an A* plan and the agent is still in the same position, since A* plans are generated for specific positions and may not be valid if the agent has moved.
     * If we can't keep the current plan, we should clear it so that a new plan will be generated on the next execution cycle.
     * @param from The agent's current position, used to determine if the current A* plan is still valid. If the current plan is from A* and the agent has moved from the position it was generated for, we should not keep it. For PDDL plans, we can ignore the position since they are more flexible and we want to give them more time to execute.
     * @returns true if we can keep and reuse the current plan, false if we should clear it and generate a new plan on the next execution cycle. The Executor should call this at the start of each execution cycle to determine whether to keep the current plan or clear it and trigger a re-plan.
     */
    private keepCurrentPlan(from: Position | undefined): boolean {
        // If there's no current plan, we obviously can't keep it.
        if (!this.currentPlan) return false;

        // If the current plan is from PDDL, we can keep it regardless of the agent's position
        if (this.currentPlan.source === "pddl") return true;

        // For A* plans, we can only keep it if the agent is still in the same position it was generated for, since A* plans are position-specific.
        if (from && this.astarPlanner.canReuse(this.currentPlan, from, this.intentionManager)) return true;
        this.astarPlanner.reset();
        this.currentPlan = null;
        return false;
    }

    /**
     * Plan a CLEAR_CRATE intention using the PDDL planner. If a plan is already ready from the PDDL planner, use it immediately.
     * @param from The agent's current position, used as the starting point for the plan. If the PDDL plan starts from a different position, we will need to prepend a bridging A* plan to get there before executing the PDDL steps.
     * @param desire The CLEAR_CRATE desire that we want to plan for. This includes the target location we want to clear the crate from and the IDs of the crates involved, which will be used to generate the PDDL problem.
     * @returns A Plan if one is ready from the PDDL planner, with a bridging A* plan prepended if necessary to get from the agent's current position to the PDDL plan's starting position. Returns null if no PDDL plan is currently ready, in which case the PDDL planner will be asynchronously working on generating a plan and will call onPddlReady when it's ready to trigger a re-plan. The Executor should call this at the start of each execution cycle when the head intention is a CLEAR_CRATE desire, to check if a PDDL plan is ready and use it if so. If this returns null, the Executor should wait and let the PDDL planner do its work, and rely on the onPddlReady callback to trigger a re-plan when the PDDL plan is ready.
     */
    private pddlHandler(from: Position, desire: ClearCrateDesire): Plan | null {
        // If the PDDL planner already has a ready plan for this desire, we can use it immediately.
        const ready = this.pddlPlanner.consume();

        // If the plan is ready but starts from a different position, we need to prepend a bridging A* plan to get there before executing the PDDL steps. 
        if (ready) return this.withBridge(from, ready);

        // If the plan is not ready, we should trigger the PDDL planner to start working on it if it hasn't already
        this.pddlPlanner.request(desire, plan => {
            if (!plan) this.intentionManager.dropIntentionHead();
            this.onPddlReady();
        });
        return null;
    }

    /**
     * Detect whether a crate is blocking the path to the target of the given desire, and if so, return a CLEAR_CRATE desire for it. 
     * @param desire The desire we want to achieve, which includes the target location we want to reach or deliver to. 
     * @param from The agent's current position, used as the starting point for pathfinding to detect if a crate is blocking the way.
     * @returns 
     */
    private detectCrateBlock(desire: NavigationDesire, from: Position): ClearCrateDesire | null {
        // Get the current crates from beliefs and check if any of them are on the path from the agent's current position.
        const crates = this.beliefs.map.getCurrentCrates().flatMap(c =>
            c.lastPosition ? [{ id: c.id, position: c.lastPosition }] : []
        );
        if (crates.length === 0) return null;
        const crateKeys = new Set(crates.map(c => posKey(c.position)));

        // If there are no path on the map, then we can't detect a crate block and should just return null to avoid false positives.
        const path = this.astarPlanner.pathIgnoringCrates(from, desire.target, crateKeys);
        if (!path) return null;

        // Convert all keys to ids taking all crates in beliefs
        const crateIds = crates.filter(c => crateKeys.has(posKey(c.position))).map(c => c.id);

        return crateIds.length > 0 ? { type: "CLEAR_CRATE", target: desire.target, crateIds } : null;
    }

    /**
     * Check whether the current beliefs still show a crate on the path to the given target.
     * @param from The agent's current position.
     * @param target The target position we want to reach.
     * @returns True if at least one believed crate still lies on the path, false otherwise.
     */
    private hasCrateOnPath(from: Position, target: Position): boolean {
        const crates = this.beliefs.map.getCurrentCrates().flatMap(c =>
            c.lastPosition ? [{ position: c.lastPosition }] : []
        );
        if (crates.length === 0) return false;

        const crateKeys = new Set(crates.map(c => posKey(c.position)));
        const path = this.astarPlanner.pathIgnoringCrates(from, target, crateKeys);
        return !!path && path.some(pos => crateKeys.has(posKey(pos)));
    }

    /**
     * Helper function to request a PDDL plan for a given CLEAR_CRATE desire.
     */
    private requestForBlock(crateBlock: ClearCrateDesire): void {
        // If the PDDL planner is already waiting for this crate block, or if we already have a tracked desire for it, we should not request another plan
        if (this.pddlPlanner.isWaiting() || this.intentionManager.hasCrateDesireFor(crateBlock.crateIds)) return;
        
        // Request a PDDL plan to clear the crate blocking the way to the current intention's target. 
        this.pddlPlanner.request(crateBlock, plan => {
            if (plan) this.intentionManager.addCrateDesire(crateBlock);
            this.onPddlReady();
        });
    }

    /**
     * Prepends a bridging A* plan to the given PDDL plan if the PDDL plan starts from a different position.
     * @param from The agent's current position.
     * @param plan The PDDL plan to prepend the bridging steps to.
     * @returns A new plan with the bridging steps prepended, or the original plan if no bridging is needed.
     */
    private withBridge(from: Position, plan: Plan): Plan {
        const firstStep = plan.steps[0];
        if (!firstStep || firstStep.kind !== "move") return plan;

        // If the first step of the PDDL plan is a move but it's not from the agent's current position, we need to prepend a bridging A* plan to get there before executing the PDDL steps. 
        const deltas: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [1, 0], right: [-1, 0] };
        const [dx, dy] = deltas[firstStep.direction] ?? [0, 0];

        // The first step of the PDDL plan is a move in a direction
        const agentFrom = { x: firstStep.to.x + dx, y: firstStep.to.y + dy };
        if (posKey(from) === posKey(agentFrom)) return plan;

        // We need to bridge from the agent's current position to the starting position of the PDDL plan. 
        const bridgeSteps = this.astarPlanner.stepsTo(from, agentFrom);
        return bridgeSteps?.length ? { ...plan, steps: [...bridgeSteps, ...plan.steps], cursor: 0 } : plan;
    }

    /**
     * Helper function to get the active planner for a given plan, based on its source. 
     */
    private activePlanner(plan: Plan): AStarPlanner | PddlPlanner { return plan.source === "pddl" ? this.pddlPlanner : this.astarPlanner; }

    /**
     * Helper function to complete the current plan and drop the head intention. 
     */
    private completePlan(): void { this.currentPlan = null; this.intentionManager.dropIntentionHead(); }
}
