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

// All desires require navigation and always have a `target` position
export type NavigationDesire = ExploreDesire | ReachParcelDesire | DeliverParcelDesire;

export type DesireType = NavigationDesire;

// Grouped map for easier access to desires by type
export type GeneratedDesires = Map<DesireType["type"], DesireType[]>;
