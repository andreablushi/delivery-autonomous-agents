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
    bonus?: number;         // Optional reward bonus added to carried score (used by LLM-injected desires)
};

export type ReachTileDesire = {
    type: "REACH_TILE";     // The agent wants to navigate to a specific tile
    target: Position;       // Target tile position
    sourceId: string;       // Sender agent id (for logging / dedupe)
    expiresAt: number;      // Expiry timestamp (ms epoch)
    reward: number;         // Mock reward used by the sorter
};

export type HoldTileDesire = {
    type: "HOLD_TILE";      // Navigate to target tile and remain there until released
    target: Position;       // Tile to navigate to and hold
    sourceId: string;       // Sender agent id (for logging / dedupe)
    reward: number;         // Priority bias; scored identically to REACH_TILE
    // When set, the hold auto-releases once self + all known friends are within
    // maxDistance of center (used by rendezvous; absent for red-light holds).
    releaseZone?: { center: Position; maxDistance: number };
};

// All desires require navigation and always have a `target` position
export type NavigationDesire = ExploreDesire | ReachParcelDesire | DeliverParcelDesire | ReachTileDesire | HoldTileDesire;

export type DesireType = NavigationDesire;

// Grouped map for easier access to desires by type
export type GeneratedDesires = Map<DesireType["type"], DesireType[]>;
