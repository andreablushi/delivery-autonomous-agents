import type { PlanStep } from "../../../../models/plan.js";
import type { Position } from "../../../../models/position.js";
import { directionBetween } from "../utils/action_mapper.js";

// Parser for converting raw PDDL plan strings into the PlanStep format used by the agent's executor.
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

// Converts a MOVE or PUSH action with tile args into a PlanStep move action with direction.
function toMoveStep(args: string[]): PlanStep {
    const from = parseTileId(args[0]);
    const to = parseTileId(args[1]);
    return { kind: "move", to, direction: directionBetween(from, to) };
}

// Parses the raw PDDL plan steps into PlanSteps for the agent's executor, stopping after the last PUSH step.
export function parsePlanString(planStr: string): PddlPlanStep[] {
    return planStr.split("\n").flatMap(line => {
        const [action, ...args] = line.replace(/[()]/g, "").trim().split(/\s+/);
        return action ? [{ parallel: false, action, args }] : [];
    });
}

/**
 * Parses the raw PDDL plan steps into PlanSteps for the agent's executor, stopping after the last PUSH step.
 * If no PUSH steps are present, returns an empty array to indicate the plan is not useful (navigation-only).
 * This ensures the agent re-enters the normal BDI loop immediately if the solver fails to produce a valid multi-pickup plan.
 * @param rawPlan The raw plan steps returned by the PDDL solver, already parsed into action and args.
 * @returns An array of PlanSteps for the agent's executor, up to and including the last PUSH step. Returns [] if no PUSH steps are present.
 */
export function parsePddlPlan(rawPlan: PddlPlanStep[]): PlanStep[] {
    // The solver may return plans that include only MOVE steps
    const steps: PlanStep[] = [];

    // Capture the push window so we only execute the crate-moving portion of the plan.
    let lastPushIdx = -1;
    let firstPushIdx = -1;
    // Convert each raw plan step into a PlanStep for the executor, tracking the index of the last PUSH step
    for (const { action, args } of rawPlan) {
        const kind = action.toLowerCase().split("-")[0];
        if (kind === "move" || kind === "push") {
            steps.push(toMoveStep(args)); // push-X moves the agent into crateFrom (args[1])
            if (kind === "push") {
                if (firstPushIdx < 0) firstPushIdx = steps.length - 1;
                lastPushIdx = steps.length - 1;
            }
            continue;
        }
        // For pickup and putdown, we can ignore the args since they are executed at the agent's current position
        if (ACTION_STEP[kind]) steps.push(ACTION_STEP[kind]);
        else console.warn(`[PDDL] Unknown action: ${action}`);
    }

    // Stop after the last push crate step, but start at the first push so we only keep the push segment.
    return firstPushIdx >= 0 ? steps.slice(firstPushIdx, lastPushIdx + 1) : [];
}
