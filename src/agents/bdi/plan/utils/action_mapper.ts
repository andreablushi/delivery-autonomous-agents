import type { Position } from "../../../../models/position.js";
import type { MoveDirection, PlanStep } from "../../../../models/plan.js";

/** Direction of the step from `from` to `to` (assumed adjacent). */
export function directionBetween(from: Position, to: Position): MoveDirection {
    if (to.x > from.x) return "right";
    if (to.x < from.x) return "left";
    if (to.y > from.y) return "up";
    return "down";
}

/**
 * Convert an A*-style ordered Position[] (excluding start, including goal) into
 * a sequence of move PlanSteps. A leading `start` is required to derive the first direction.
 */
export function toMoveSteps(start: Position, path: Position[]): PlanStep[] {
    const steps: PlanStep[] = [];
    let prev = start;
    for (const next of path) {
        steps.push({ kind: "move", to: next, direction: directionBetween(prev, next) });
        prev = next;
    }
    return steps;
}
