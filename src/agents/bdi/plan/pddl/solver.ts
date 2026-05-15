import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
