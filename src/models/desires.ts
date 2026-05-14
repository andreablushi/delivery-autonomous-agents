/**
 * Desire types for the BDI agent.
 * Pickup/putdown actions are no longer separate desires: they are appended as
 * terminal PlanSteps on REACH_PARCEL / DELIVER_PARCEL plans by the Planner.
 */

import type { Position } from "./position.js";

export type ExploreDesire = {
    type: "EXPLORE";        // The agent wants to explore the map
    target: Position;       // A spawn tile to walk toward as a fallback goal
};

export type ReachParcelDesire = {
    type: "REACH_PARCEL";   // The agent wants to navigate to and collect a parcel
    target: Position;       // Last known position of the target parcel
};

export type DeliverParcelDesire = {
    type: "DELIVER_PARCEL"; // The agent wants to navigate to the nearest delivery tile
    target: Position;       // Nearest delivery tile position
};

export type ReachPointDesire = {
    type: "REACH_POINT";    // Navigate to a specific tile (used as a bridge before executing a PDDL plan)
    target: Position;       // Tile the agent must stand on before the PDDL plan starts
};

// All desires require navigation and always have a `target` position
export type NavigationDesire = ExploreDesire | ReachParcelDesire | DeliverParcelDesire | ReachPointDesire;

export type ClearCrateDesire = {
    type: "CLEAR_CRATE";
    target: Position;        // original target the agent wants to reach (PDDL goal: at destination)
    crateIds: string[];      // IDs of crates detected as blocking this route
};

export type DesireType = NavigationDesire | ClearCrateDesire;

// Grouped map for easier access to desires by type
export type GeneratedDesires = Map<DesireType["type"], DesireType[]>;
