import type { Position } from "./position.js";

/** A desire to explore the space */
export type ExploreDesire = {
    type: "EXPLORE";        // The agent wants to explore the map
    target: Position;       // A spawn tile to walk toward as a fallback goal
};

/** A desire to reach a specific parcel */
export type ReachParcelDesire = {
    type: "REACH_PARCEL";   // The agent wants to navigate to and collect a parcel
    target: Position;       // Last known position of the target parcel
};

/** A desire to deliver a specific parcel */
export type DeliverParcelDesire = {
    type: "DELIVER_PARCEL"; // The agent wants to navigate to the nearest delivery tile
    target: Position;       // Nearest delivery tile position
    bonus?: number;         // Optional reward bonus added to carried score (used by LLM-injected desires)
};

// Two tile-navigation desires — choose based on intended behavior:
//   go   — REACH_TILE: tier 1, competes with REACH_PARCEL/DELIVER_PARCEL, pruned on arrival (one-shot waypoint).
//   stay — HOLD_TILE: non-preemptible commitment; anchors the agent (∞ at target) until released.

/** A desire to reach a specific tile (navigate there, then resume; competes with parcel desires) */
export type ReachTileDesire = {
    type: "REACH_TILE";     // Navigate to target tile; head is dropped on arrival
    target: Position;       // Target tile position
    sourceId: string;       // Sender agent id (for logging / dedupe)
    expiresAt: number;      // Expiry timestamp (ms epoch)
    reward: number;         // Mock reward used by the sorter
};

/** A desire to hold a specific tile (navigate there and remain until released)*/
export type HoldTileDesire = {
    type: "HOLD_TILE";      // Navigate to target tile and remain there until released
    target: Position;       // Tile to navigate to and hold
    sourceId: string;       // Sender agent id (for logging / dedupe)
    reward: number;         // Priority bias; scored identically to REACH_TILE
    // When set, the hold auto-releases once self + all known friends are within
    // maxDistance of center (used by rendezvous; absent for red-light holds).
    releaseZone?: { center: Position; maxDistance: number };
    rendezvousId?: string;  // Unique id of the rendezvous round that produced this hold (for logging / future cleanup)
};

/** Union type for all possible desire types*/
export type DesireType = ExploreDesire | ReachParcelDesire | DeliverParcelDesire | ReachTileDesire | HoldTileDesire;

/** Maps desire type strings to arrays of corresponding desires (e.g. "EXPLORE" -> ExploreDesire[]) */
export type GeneratedDesires = Map<DesireType["type"], DesireType[]>;

/** A desire wrapped with its computed score and priority tier — the output of the ranker. */
export type ScoredDesire = { desire: DesireType; score: number; priority: number };

/** Ordered list of scored desires; head is the active intention the agent is committed to pursuing. */
export type DesireQueue = ScoredDesire[];

/** A desire injected by an external source (LLM, peer agent) that persists across deliberation ticks until it expires. */
export type InjectedDesire = { desire: DesireType; expiresAt?: number; sourceId: string };
