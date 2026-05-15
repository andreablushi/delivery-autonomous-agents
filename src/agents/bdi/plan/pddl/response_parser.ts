import type { PlanStep } from "../../../../models/plan.js";
import type { Position } from "../../../../models/position.js";
import { directionBetween } from "../utils/action_mapper.js";
import { createLogger, type Logger } from "../../../../utils/logger.js";

const defaultLog = createLogger("pddl");

export type PddlPlanStep = { parallel: boolean; action: string; args: string[] };

/** Converts raw PDDL plan steps into the PlanStep format used by the agent's executor. */
const ACTION_STEP: Partial<Record<string, PlanStep>> = {
    pickup: { kind: "pickup" },
    putdown: { kind: "putdown" },
};

// Converts a raw tile ID like "T_8_6" into a Position { x: 8, y: 6 }.
function parseTileId(id: string): Position {
    // Solver returns uppercase IDs like T_8_6; split on _ after lowercasing
    const [, x, y] = id.toLowerCase().split("_");
    return { x: Number(x), y: Number(y) };
}

// Converts a MOVE or PUSH action with tile args into a move PlanStep with direction.
function toMoveStep(args: string[]): PlanStep {
    const from = parseTileId(args[0]);
    const to = parseTileId(args[1]);
    return { kind: "move", to, direction: directionBetween(from, to) };
}

/**
 * Parse a raw PDDL plan string into an array of `PddlPlanStep` records.
 * Lines that are empty, comments, or do not start with `(` are skipped.
 * @param planStr The raw plan string returned by the solver.
 * @returns An array of parsed plan steps.
 */
export function parsePlanString(planStr: string): PddlPlanStep[] {
    return planStr.split("\n").flatMap(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(";") || !trimmed.startsWith("(")) return [];
        const [action, ...args] = trimmed.replace(/[()]/g, "").trim().split(/\s+/);
        return action ? [{ parallel: false, action, args }] : [];
    });
}

/**
 * Convert parsed PDDL plan steps into executor `PlanStep[]`.
 * Every MOVE and PUSH action produces a move step (PUSH moves the agent onto the crate tile).
 * The full path is returned — the PDDL goal already guarantees the agent ends at the target.
 * @param rawPlan The parsed plan steps from `parsePlanString`.
 * @returns An ordered array of `PlanStep` values, or an empty array if the plan is empty.
 */
export function parsePddlPlan(rawPlan: PddlPlanStep[], log: Logger = defaultLog): PlanStep[] {
    const steps: PlanStep[] = [];

    for (const { action, args } of rawPlan) {
        const kind = action.toLowerCase().split("-")[0];
        if (kind === "move" || kind === "push") {
            // push-X moves the agent onto args[1] (the crate's current tile)
            steps.push(toMoveStep(args));
        } else if (ACTION_STEP[kind]) {
            steps.push(ACTION_STEP[kind]);
        } else {
            log.warn(`Unknown action: ${action}`);
        }
    }

    return steps;
}
