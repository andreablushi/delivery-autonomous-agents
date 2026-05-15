import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import onlineSolverLib from "@unitn-asa/pddl-client/src/PddlOnlineSolver.js";
import type { PddlPlanStep } from "./response_parser.js";
import { parsePlanString } from "./response_parser.js";

const SOLVER_PATH = join(homedir(), ".planutils", "bin", "dual-bfws-ffparser");
const DOMAIN_FILE = "/tmp/domain.pddl";
const PROBLEM_FILE = "/tmp/problem.pddl";
const PLAN_FILE = "/tmp/plan";

export function localSolver(pddlDomain: string, pddlProblem: string, debug = false): string {
    const startedAt = Date.now();
    writeFileSync(DOMAIN_FILE, pddlDomain);
    writeFileSync(PROBLEM_FILE, pddlProblem);
    // Remove any stale plan from a previous run
    if (existsSync(PLAN_FILE)) unlinkSync(PLAN_FILE);

    debug && console.log("[PDDL SOLVER] Starting local solver");

    const result = spawnSync(SOLVER_PATH, [DOMAIN_FILE, PROBLEM_FILE], { cwd: "/tmp" });

    debug && console.log(`[PDDL SOLVER] Solver process exited with code ${result.status} and signal ${result.signal}`);
    // dual-bfws (LAPKT) writes the plan to plan.ipc, not stdout
    if (existsSync(PLAN_FILE)) {
        debug && console.log(`[PDDL SOLVER] Plan file found, reading result from ${PLAN_FILE}`);
        const plan = readFileSync(PLAN_FILE, "utf8");
        unlinkSync(PLAN_FILE);
        debug && console.log(`[PDDL SOLVER] Result ready in ${Date.now() - startedAt}ms`);
        return plan;
    }

    // Fallback: parse plan from stdout
    const output = result.stdout?.toString() ?? "";
    debug && console.log(`[PDDL SOLVER] Result ready in ${Date.now() - startedAt}ms`);
    return output;
}

async function onlineSolver(pddlDomain: string, pddlProblem: string, debug: boolean): Promise<PddlPlanStep[]> {
    try {
        const startedAt = Date.now();
        debug && console.log("[PDDL SOLVER] Sending request to online solver");
        const result = await onlineSolverLib(pddlDomain, pddlProblem);
        debug && console.log(`[PDDL SOLVER] Online solver result ready in ${Date.now() - startedAt}ms`);
        if (!result) return [];
        return result as PddlPlanStep[];
    } catch (err) {
        console.error("[PDDL SOLVER] Online solver error:", err);
        return [];
    }
}

/**
 * Select the solver to use based on the PAAS_HOST env var.
 * If PAAS_HOST is set, use the online solver; otherwise use the local binary.
 * Decision is made once at startup.
 */
export function selectSolver(debug: boolean): (domain: string, problem: string) => Promise<PddlPlanStep[]> {
    const paasHost = process.env.PAAS_HOST;
    if (paasHost) {
        console.log(`[PDDL SOLVER] Online solver enabled (PAAS_HOST=${paasHost})`);
        return (domain, problem) => onlineSolver(domain, problem, debug);
    }
    console.log("[PDDL SOLVER] Local solver in use");
    return async (domain, problem) => parsePlanString(localSolver(domain, problem, debug));
}
