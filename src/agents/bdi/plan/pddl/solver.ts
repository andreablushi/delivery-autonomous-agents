import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../../../utils/logger.js";
import onlineSolverLib from "@unitn-asa/pddl-client/src/PddlOnlineSolver.js";
import type { PddlPlanStep } from "./response_parser.js";
import { parsePlanString } from "./response_parser.js";

const SOLVER_PATH = join(homedir(), ".planutils", "bin", "dual-bfws-ffparser");
const DOMAIN_FILE = "/tmp/domain.pddl";
const PROBLEM_FILE = "/tmp/problem.pddl";
const PLAN_FILE = "/tmp/plan";

export function localSolver(pddlDomain: string, pddlProblem: string, log: Logger): string {
    const startedAt = Date.now();
    writeFileSync(DOMAIN_FILE, pddlDomain);
    writeFileSync(PROBLEM_FILE, pddlProblem);
    // Remove any stale plan from a previous run
    if (existsSync(PLAN_FILE)) unlinkSync(PLAN_FILE);

    log.debug("Starting local solver");

    const result = spawnSync(SOLVER_PATH, [DOMAIN_FILE, PROBLEM_FILE], { cwd: "/tmp" });

    log.debug(`Solver process exited with code ${result.status} and signal ${result.signal}`);
    // dual-bfws (LAPKT) writes the plan to plan.ipc, not stdout
    if (existsSync(PLAN_FILE)) {
        log.debug(`Plan file found, reading result from ${PLAN_FILE}`);
        const plan = readFileSync(PLAN_FILE, "utf8");
        unlinkSync(PLAN_FILE);
        log.debug(`Result ready in ${Date.now() - startedAt}ms`);
        return plan;
    }

    // Fallback: parse plan from stdout
    const output = result.stdout?.toString() ?? "";
    log.debug(`Result ready in ${Date.now() - startedAt}ms`);
    return output;
}

async function onlineSolver(pddlDomain: string, pddlProblem: string, logger: Logger): Promise<PddlPlanStep[]> {
    try {
        const startedAt = Date.now();
        logger.debug("[PDDL SOLVER] Sending request to online solver");
        const result = await onlineSolverLib(pddlDomain, pddlProblem);
        logger.debug(`[PDDL SOLVER] Online solver result ready in ${Date.now() - startedAt}ms`);
        if (!result) return [];
        return result as PddlPlanStep[];
    } catch (err) {
        logger.error("[PDDL SOLVER] Online solver error:", err);
        return [];
    }
}

/**
 * Select the solver to use based on the PAAS_HOST env var.
 * If PAAS_HOST is set, use the online solver; otherwise use the local binary.
 * Decision is made once at startup.
 * @param log Logger instance to forward to the chosen solver.
 */
export function selectSolver(log: Logger): (domain: string, problem: string) => Promise<PddlPlanStep[]> {
    const paasHost = process.env.PAAS_HOST;
    if (paasHost) {
        console.log(`[PDDL SOLVER] Online solver enabled (PAAS_HOST=${paasHost})`);
        return (domain, problem) => onlineSolver(domain, problem, log);
    }
    console.log("[PDDL SOLVER] Local solver in use");
    return async (domain, problem) => parsePlanString(localSolver(domain, problem, log));
}
