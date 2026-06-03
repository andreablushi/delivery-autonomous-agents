import type { Position } from "./position.js";
import type { DesireType } from "./desires.js";
import type { LocatedCrate } from "./crate.js";

/** Direction of movement for a move action in a plan */
export type MoveDirection = "up" | "down" | "left" | "right";

/** Decision returned by CollisionManager on each collision event. */
export type CollisionDecision =
    | { kind: 'wait' }                  // Continue waiting for the tile to clear; do not mark it as blocked yet.
    | { kind: 'block'; ttl: number };   // Mark the tile as blocked for the given TTL (e.g. after waiting too long or too many retries).

/** A single step in the execution plan */
export type PlanStep =
    | { kind: "move"; to: Position; direction: MoveDirection }
    | { kind: "pickup" }   // executed at the tile where the agent stands
    | { kind: "putdown" }; // executed at the tile where the agent stands

export type PlanSource = "astar" | "pddl";

/** The crate-blocked segment on a push-aware path, used as input to the PDDL maneuver solver. */
export type CrateSegment = {
    entry: Position;
    exit: Position;
    clusterCrates: LocatedCrate[];
};

/** A plan for executing a navigation desire, consisting of a sequence of steps and metadata about its source and target desire. */
export type Plan = {
    source: PlanSource;
    steps: PlanStep[];
    cursor: number;        // index of the next step to execute
    target: DesireType;    // the navigation desire this plan was built for
};
