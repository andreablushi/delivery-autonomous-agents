/**
 * Plan types for the BDI agent's planner.
 * A Plan is a concrete sequence of executable steps (move/pickup/putdown) that
 * achieves the underlying desire. Plans come from two sources: A* for single-target
 * navigation, and PDDL for multi-pickup tours composed over the top-N intention queue.
 */

import type { Position } from "./position.js";
import type { DesireType } from "./desires.js";

export type MoveDirection = "up" | "down" | "left" | "right";

/** Decision returned by CollisionManager on each collision event. */
export type CollisionDecision =
    | { kind: 'wait' }                  // Continue waiting for the tile to clear; do not mark it as blocked yet.
    | { kind: 'block'; ttl: number };   // Mark the tile as blocked for the given TTL (e.g. after waiting too long or too many retries).

export type PlanStep =
    | { kind: "move"; to: Position; direction: MoveDirection }
    | { kind: "pickup" }   // executed at the tile where the agent stands
    | { kind: "putdown" }; // executed at the tile where the agent stands

export type PlanSource = "astar" | "pddl";

export type Plan = {
    source: PlanSource;
    steps: PlanStep[];
    cursor: number;        // index of the next step to execute
    target: DesireType;    // the desire this plan was built for
};
