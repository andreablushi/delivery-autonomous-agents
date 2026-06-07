import type { Position } from "./position.js";

/** High-level cooperation strategy a GameStrategy belongs to. */
export const StrategyType = {
    ZonalRelay:   "ZONAL_RELAY",   // Pickup agent sweeps the full spawn region, drops at the spawn-side edge tile; deliver agent ferries to real delivery tiles.
    Opportunistic: "OPPORTUNISTIC", // Handshake-driven handpass: first to pick up becomes PASSER, partner becomes RECEIVER.
} as const;
export type StrategyType = typeof StrategyType[keyof typeof StrategyType];

/** Role assigned to an agent within a GameStrategy. */
export const StrategyRole = {
    PickupAgent:  "PICKUP_AGENT",  // ZONAL_RELAY: sweep spawn-region parcels, carry to edge tile, drop
    DeliverAgent: "DELIVER_AGENT", // ZONAL_RELAY: wait at edge tile, pick up grounded parcels, deliver, return
    Passer:       "PASSER",        // OPPORTUNISTIC: carry parcels to meet tile, wait for receiver, drop
    Receiver:     "RECEIVER",      // OPPORTUNISTIC: go to meet tile, collect dropped parcels, deliver
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
    /** Hold-zone radius around the assigned tile (Manhattan). */
    maxDistance: number;
    /** Cross-agent delivery bonus used by the handshake heuristic and drop priority. */
    bonus?: number;
    /** ZONAL_RELAY: the teammate this strategy pairs with. */
    partnerId?: string;
    /** This agent's exact wait cell, one step adjacent to the exchange tile tiles[0]. */
    approachTile?: Position;
    /** TTL as ms epoch; omitted ⇒ no expiry. */
    expiresAt?: number;
};
