import type { Position } from "./position.js";

/** High-level cooperation strategy a GameStrategy belongs to. */
export const StrategyType = {
    // Pickup agent sweeps the full spawn region, drops parcels at the midpoint;
    // deliver agent ferries to real delivery tiles.
    ZonalRelay:   "ZONAL_RELAY",
    // Both agents work indipendently, the first to pick up a parcel
    // initiate a handoff at a meet tile
    Opportunistic: "OPPORTUNISTIC",
} as const;
export type StrategyType = typeof StrategyType[keyof typeof StrategyType];

/** Role assigned to an agent within a GameStrategy. */
export const StrategyRole = {
    PickupAgent:  "PICKUP_AGENT",  // ZONAL_RELAY: sweep spawn-region parcels, carry to meet tile, drop
    DeliverAgent: "DELIVER_AGENT", // ZONAL_RELAY: wait at meet tile, pick up grounded parcels, deliver, return
    Passer:       "PASSER",        // OPPORTUNISTIC: carry parcels to meet tile, wait for receiver, drop
    Receiver:     "RECEIVER",      // OPPORTUNISTIC: go to meet tile, collect dropped parcels, deliver
} as const;
export type StrategyRole = typeof StrategyRole[keyof typeof StrategyRole];

/** Single source of truth: each strategy and the roles it allows. */
export const ROLES_BY_STRATEGY = {
    [StrategyType.ZonalRelay]:    [StrategyRole.PickupAgent, StrategyRole.DeliverAgent],
    [StrategyType.Opportunistic]: [StrategyRole.Passer, StrategyRole.Receiver],
} as const;

/**
 * A per-agent cooperation directive.
 * At most one is active per agent; pruned by TTL. Set by the coordination LLM
 * (locally or via an `assign_strategy` peer message). A deterministic per-role
 * state machine in RoleController translates the role into gated desires each cycle.
 */
export type GameStrategy =
    | {
          strategy: typeof StrategyType.ZonalRelay;
          role: typeof ROLES_BY_STRATEGY[typeof StrategyType.ZonalRelay][number];
          meetTile: Position;
          approachTile?: Position;
          maxDistance: number;
          bonus?: number;
          expiresAt?: number;
          partnerId: string;   // required — the relay pairing needs a known partner
      }
    | {
          strategy: typeof StrategyType.Opportunistic;
          role: typeof ROLES_BY_STRATEGY[typeof StrategyType.Opportunistic][number];
          meetTile: Position;
          approachTile?: Position;
          maxDistance: number;
          bonus?: number;
          expiresAt?: number;
          partnerId?: string;  // carrier uses it; receiver does not
      };
