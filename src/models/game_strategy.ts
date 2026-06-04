import type { Position } from "./position.js";

/** High-level cooperation strategy a GameStrategy belongs to. */
export const StrategyType = {
    Positioning: "POSITIONING", // Hold assigned tiles to cover the map
    Handoff:     "HANDOFF",     // Pickup → midpoint drop → teammate delivers (earns the cross-agent bonus)
} as const;
export type StrategyType = typeof StrategyType[keyof typeof StrategyType];

/** Role assigned to an agent within a GameStrategy. */
export const StrategyRole = {
    Camper:       "CAMPER",        // POSITIONING: hold an assigned spawn-cluster tile
    Midfielder:   "MIDFIELDER",    // POSITIONING: hold a midpoint tile
    PickupAgent:  "PICKUP_AGENT",  // HANDOFF: grab parcels, carry to midpoint, drop
    DeliverAgent: "DELIVER_AGENT", // HANDOFF: hold near midpoint, receive the drop, deliver
} as const;
export type StrategyRole = typeof StrategyRole[keyof typeof StrategyRole];

/**
 * A per-agent cooperation directive, analogous to an InjectedIntention.
 * At most one is active per agent; pruned by TTL. Set by the coordination LLM
 * (locally or via an `assign_strategy` peer message). The agent translates the
 * active role into existing injected desires (HOLD_TILE / DELIVER_PARCEL) and,
 * for HANDOFF, reacts to real pickups by initiating a handshake.
 */
export type GameStrategy = {
    strategy: StrategyType;
    role: StrategyRole;
    /** POSITIONING: the hold tile. HANDOFF: the midpoint (drop/meeting point). */
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
