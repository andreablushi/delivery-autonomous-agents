import type { Position } from "./position.js";

/** High-level cooperation strategy a GameStrategy belongs to. */
export const StrategyType = {
    Handoff: "HANDOFF", // Pickup agent collects in zone, delivers to midpoint; deliver agent receives and delivers.
} as const;
export type StrategyType = typeof StrategyType[keyof typeof StrategyType];

/** Role assigned to an agent within a GameStrategy. */
export const StrategyRole = {
    PickupAgent:  "PICKUP_AGENT",  // HANDOFF: collect in-zone parcels, carry to midpoint, drop
    DeliverAgent: "DELIVER_AGENT", // HANDOFF: wait at midpoint, pick up grounded parcels, deliver, return
} as const;
export type StrategyRole = typeof StrategyRole[keyof typeof StrategyRole];

/**
 * A per-agent cooperation directive.
 * At most one is active per agent; pruned by TTL. Set by the coordination LLM
 * (locally or via an `assign_strategy` peer message). A deterministic per-role
 * state machine in RoleController translates the role into gated desires each cycle.
 */
export type GameStrategy = {
    strategy: StrategyType;
    role: StrategyRole;
    /** HANDOFF: the meet-zone midpoint where PICKUP drops and DELIVER picks up. */
    tiles: Position[];
    /**
     * HANDOFF/PICKUP_AGENT only: the spawn-cluster centroid to camp while collecting parcels.
     * When set, the agent generates REACH_TILE desires around this center (not tiles[0]) and
     * zone-aware parcel scoring uses this as the zone center. tiles[0] still holds the midpoint
     * used for the handshake drop.
     */
    pickupZoneCenter?: Position;
    /** Hold-zone radius around the assigned tile (Manhattan). */
    maxDistance: number;
    /** Cross-agent delivery bonus used by the handshake heuristic and drop priority. */
    bonus?: number;
    /** HANDOFF: the teammate this strategy pairs with. */
    partnerId?: string;
    /** TTL as ms epoch; omitted ⇒ no expiry. */
    expiresAt?: number;
};
