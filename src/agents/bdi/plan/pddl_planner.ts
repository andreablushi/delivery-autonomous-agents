import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Beliefs } from "../belief/beliefs.js";
import type { NavigationDesire } from "../../../models/desires.js";
import type { Plan, PlanStep, CrateSegment } from "../../../models/plan.js";
import type { Position } from "../../../models/position.js";
import { buildProblem } from "./pddl/problem_builder.js";
import { parsePddlPlan } from "./pddl/response_parser.js";
import { selectSolver } from "./pddl/solver.js";
import type { PddlPlanStep } from "./pddl/response_parser.js";
import { TERMINAL_STEP } from "./astar_planner.js";
import { CollisionTimer } from "./collision/collision_timer.js";
import { createLogger, type Logger } from "../../../utils/logger.js";
import { config } from "../../../config.js";

const CRATE_DOMAIN_PATH = join(dirname(fileURLToPath(import.meta.url)), "pddl", "domain-crates.pddl");

/**
 * PDDL planner for navigation desires whose path is blocked by crates.
 * Mirrors the shape of `AStarPlanner`: `plan()` is synchronous and returns a complete
 * plan or null if the solver fails. No async request, no fire-and-check cycle.
 */
export class PddlPlanner {
    private readonly domain: string;
    private readonly solve: (domain: string, problem: string) => Promise<PddlPlanStep[]>;
    private readonly timer = new CollisionTimer();
    private readonly log: Logger;
    private invalidationCount = 0;


    /** Keyed by `entry|exit|sortedCratePositions`. Stores the parsed move/push steps (no terminal). */
    private readonly maneuverCache = new Map<string, PlanStep[]>();

    constructor(
        private readonly beliefs: Beliefs,
        agentId?: string,
    ) {
        this.log = createLogger("pddl", agentId);
        this.domain = readFileSync(CRATE_DOMAIN_PATH, "utf8");
        this.solve = selectSolver(this.log);
    }

    /**
     * Generate a plan from `from` to `intention.target` via PDDL, pushing any blocking crates.
     * Builds the PDDL problem, runs the solver (local or online based on PAAS_HOST), parses the
     * full path, and appends a terminal step (pickup/putdown) for desires that require one on arrival.
     * @param from The agent's current position.
     * @param intention The navigation desire to plan for.
     * @param crateIds IDs of crates detected as blocking the direct path (used for logging only).
     * @returns A complete Plan, or null if the solver returns no valid solution.
     */
    async plan(from: Position, intention: NavigationDesire, crateIds: string[]): Promise<Plan | null> {
        this.log.debug(`Planning for ${intention.type} via ${crateIds.length} crate(s): [${crateIds.join(", ")}]`);


        const problem = buildProblem(intention.target, this.beliefs);
        if (!problem) return null;

        const steps = parsePddlPlan(await this.solve(this.domain, problem));
        if (steps.length === 0) {
            this.log.debug("Solver returned no steps");
            return null;
        }

        // Append terminal action for desires that end with a game action on arrival
        const terminal = TERMINAL_STEP[intention.type];
        if (terminal) steps.push(terminal);

        this.log.debug(`Plan ready: ${steps.length} step(s)`);
        return { source: "pddl", steps, cursor: 0, target: intention };
    }

    /**
     * Solve the crate-clearing maneuver from `segment.entry` to `segment.exit` using PDDL, with a cache.
     * The PDDL problem uses the full map (no windowing) but anchors start=entry, goal=exit —
     * decoupling the maneuver from the agent's distant position and delivery target. This lets
     * the cache key (`entry + exit + nearby crate positions`) remain stable while the agent
     * approaches the cluster along the A* prefix, so moving 1 tile toward the cluster is a hit.
     * @param segment The crate-blocked segment to clear, as returned by `findCrateSegment`.
     * @returns Parsed move/push steps (no terminal), or null if the solver fails.
     */
    async solveManeuver(segment: CrateSegment): Promise<PlanStep[] | null> {
        const { entry, exit, clusterCrates } = segment;
        const key = [
            `${entry.x},${entry.y}`,
            `${exit.x},${exit.y}`,
            clusterCrates.map(c => `${c.position.x},${c.position.y}`).sort().join("|"),
        ].join("|");

        // Check cache for existing solution before invoking the solver
        const cached = this.maneuverCache.get(key);
        if (cached) {
            this.log.debug("Maneuver cache hit");
            return [...cached];
        }

        // If not cached, build the problem and solve it
        const problem = buildProblem(exit, this.beliefs, entry);
        if (!problem) return null;
        const raw = await this.solve(this.domain, problem);
        const steps = parsePddlPlan(raw);
        if (steps.length === 0) {
            this.log.debug("Solver returned no steps for maneuver");
            return null;
        }

        // Evict oldest entry (FIFO) when the cache is full
        if (this.maneuverCache.size >= config.pddl.cacheSize) {
            const oldest = this.maneuverCache.keys().next().value;
            if (oldest !== undefined) this.maneuverCache.delete(oldest);
        }
        this.maneuverCache.set(key, steps);
        this.log.debug(`Maneuver cached (${steps.length} steps, cache size: ${this.maneuverCache.size})`);
        return [...steps];
    }

    /**
     * Get the next step from the plan.
     * If the next move tile is occupied by another agent, waits until a random backoff
     * expires before letting the move attempt through (no detour — PDDL step order is causal).
     */
    nextStep(plan: Plan, _currentPosition: Position): PlanStep | "wait" | null {
        const step = plan.steps[plan.cursor];
        if (!step) return null;
        if (step.kind !== "move") return step;

        const walkable = (a: Position, b: Position) => this.beliefs.map.isWalkable(a, b);
        if (!this.beliefs.agents.isNextBlockedByAgents(step.to, walkable)) return step;

        if (!this.timer.isWaitingFor(step.to)) {
            this.timer.start(step.to, config.pddl.waitMinMs, config.pddl.waitMaxMs);
        }
        if (!this.timer.hasExpired()) return "wait";

        return step;
    }

    /**
     * Advance the plan cursor and reset collision state.
     * @returns true if the plan is now complete.
     */
    advance(plan: Plan): boolean {
        plan.cursor++;
        this.resetCollision();
        return plan.cursor >= plan.steps.length;
    }

    /**
     * Invalidate a PDDL plan after a failed move.
     * Below the retry limit, keeps the plan so the agent can retry (e.g. agent was passing through).
     * Above the limit, marks the tile blocked in beliefs and forces a full replan.
     * Non-move failures (pickup/putdown) always force a replan.
     */
    invalidate(plan: Plan): boolean {
        const step = plan.steps[plan.cursor];
        if (!step || step.kind !== "move") return true;

        this.invalidationCount++;
        if (this.invalidationCount > config.pddl.retryLimit) {
            this.beliefs.map.markBlocked(step.to, config.pddl.blockedTtlMs);
            this.resetCollision();
            return true;
        }
        return false;
    }

    validate(_plan: Plan, _currentPosition: Position): boolean {
        return true;
    }

    reset(): void {
        this.resetCollision();
    }

    private resetCollision(): void {
        this.timer.reset();
        this.invalidationCount = 0;
    }
}
