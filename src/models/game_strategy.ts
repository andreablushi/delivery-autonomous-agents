import type { Position } from "./position.js";

/** High-level cooperation strategy a GameStrategy belongs to. */
export const StrategyType = {
    ZonalRelay: "ZONAL_RELAY", // Pickup agent sweeps the full spawn region, drops at the spawn-side edge tile; deliver agent ferries to real delivery tiles.
} as const;
export type StrategyType = typeof StrategyType[keyof typeof StrategyType];

/** Role assigned to an agent within a GameStrategy. */
export const StrategyRole = {
    PickupAgent:  "PICKUP_AGENT",  // ZONAL_RELAY: sweep spawn-region parcels, carry to edge tile, drop
    DeliverAgent: "DELIVER_AGENT", // ZONAL_RELAY: wait at edge tile, pick up grounded parcels, deliver, return
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
    /** ZONAL_RELAY: the spawn-region edge tile where PICKUP drops and DELIVER picks up. */
    tiles: Position[];
    /**
     * Unused for ZONAL_RELAY (pickup sweeps all spawn tiles via region membership).
     * Kept for forward compatibility.
     */
    pickupZoneCenter?: Position;
    /** Hold-zone radius around the assigned tile (Manhattan). */
    maxDistance: number;
    /** Cross-agent delivery bonus used by the handshake heuristic and drop priority. */
    bonus?: number;
    /** ZONAL_RELAY: the teammate this strategy pairs with. */
    partnerId?: string;
    /** TTL as ms epoch; omitted ⇒ no expiry. */
    expiresAt?: number;
};
