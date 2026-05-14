/**
 * Local PDDL solver bridge using planutils + Singularity.
 *
 * Setup (one-time):
 *   1. Install Singularity CE (Linux container runtime):
 *        https://docs.sylabs.io/guides/latest/admin-guide/installation.html
 *
 *   2. Install planutils and initialise it (writes wrapper scripts to ~/.planutils/bin):
 *        pip install planutils
 *        planutils setup
 *
 *   3. Install the dual-bfws planner image:
 *        planutils install dual-bfws-planner
 *      This downloads the Singularity image and creates the wrapper script
 *      ~/.planutils/bin/dual-bfws-ffparser that invokes the container.
 *      NOTE: dual-bfws-ffparser is a planutils wrapper, not a raw planner binary.
 *
 * At runtime, SOLVER_PATH resolves to ~/.planutils/bin/dual-bfws-ffparser
 * independently of the shell PATH, so no environment manipulation is needed.
 *
 * Plan output: dual-bfws (LAPKT) writes the plan to plan.ipc in its working
 * directory rather than stdout. localSolver sets cwd to /tmp and reads
 * /tmp/plan.ipc after the solve completes.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SOLVER_PATH = join(homedir(), ".planutils", "bin", "dual-bfws-ffparser");
const DOMAIN_FILE = "/tmp/domain.pddl";
const PROBLEM_FILE = "/tmp/problem.pddl";
const PLAN_FILE = "/tmp/plan";

export function localSolver(pddlDomain: string, pddlProblem: string): string {
    const startedAt = Date.now();
    writeFileSync(DOMAIN_FILE, pddlDomain);
    writeFileSync(PROBLEM_FILE, pddlProblem);
    // Remove any stale plan from a previous run
    if (existsSync(PLAN_FILE)) unlinkSync(PLAN_FILE);

    console.log("[PDDL SOLVER] Starting local solver");
    
    const result = spawnSync(SOLVER_PATH, [DOMAIN_FILE, PROBLEM_FILE], { cwd: "/tmp" });
    // Read domain and problem for debugging since the solver's error messages are opaque
    // dual-bfws (LAPKT) writes the plan to plan.ipc, not stdout
    if (existsSync(PLAN_FILE)) {
        const plan = readFileSync(PLAN_FILE, "utf8");
        unlinkSync(PLAN_FILE);
        console.log(`[PDDL SOLVER] Result ready in ${Date.now() - startedAt}ms`);
        return plan;
    }

    // Fallback: parse plan from stdout (format: lines ending with ")")
    const output = result.stdout?.toString() ?? "";
    console.log(`[PDDL SOLVER] Result ready in ${Date.now() - startedAt}ms`);
    return output;
}
