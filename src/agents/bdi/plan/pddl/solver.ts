import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "../../../../utils/logger.js";
import onlineSolverLib from "@unitn-asa/pddl-client/src/PddlOnlineSolver.js";
import type { PddlPlanStep } from "./response_parser.js";
import { parsePlanString } from "./response_parser.js";

const execFile = promisify(execFileCb);
const SOLVER_PATH = join(homedir(), ".planutils", "bin", "dual-bfws-ffparser");

/**
 * Run the local PDDL solver asynchronously in an isolated temp directory.
 * Using a per-call temp dir prevents file collisions when multiple agents fall back to PDDL
 * concurrently (the old fixed /tmp/domain.pddl paths would be clobbered in that case).
 */
export async function localSolver(pddlDomain: string, pddlProblem: string, log: Logger): Promise<string> {
    const startedAt = Date.now();
    const tmpDir = mkdtempSync(join(tmpdir(), "pddl-"));
    const domainFile = join(tmpDir, "domain.pddl");
    const problemFile = join(tmpDir, "problem.pddl");
    const planFile = join(tmpDir, "plan");

    writeFileSync(domainFile, pddlDomain);
    writeFileSync(problemFile, pddlProblem);

    log.debug("Starting local solver");

    let stdout = "";
    try {
        const result = await execFile(SOLVER_PATH, [domainFile, problemFile], { cwd: tmpDir });
        stdout = result.stdout ?? "";
        log.debug("Solver process exited successfully");
    } catch (err: any) {
        // dual-bfws (LAPKT) may exit with non-zero even when it successfully writes a plan file
        stdout = err?.stdout ?? "";
        log.debug(`Solver process exited with code ${err?.code}`);
    }

    try {
        // dual-bfws (LAPKT) writes the plan to plan.ipc, not stdout
        if (existsSync(planFile)) {
            log.debug(`Plan file found, reading result from ${planFile}`);
            const plan = readFileSync(planFile, "utf8");
            log.debug(`Result ready in ${Date.now() - startedAt}ms`);
            return plan;
        }

        // Fallback: parse plan from stdout
        log.debug(`Result ready in ${Date.now() - startedAt}ms`);
        return stdout;
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
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
    return async (domain, problem) => parsePlanString(await localSolver(domain, problem, log));
}
