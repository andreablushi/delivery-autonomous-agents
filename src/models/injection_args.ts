import { StrategyType, StrategyRole } from "./game_strategy.js";

/** Coerce string-encoded numbers to actual numbers; leave all other values untouched. */
function coerceNum(v: unknown): unknown {
    return typeof v === "string" && v.trim() !== "" ? Number(v) : v;
}


/** Arguments shared by `request_goto` and `request_putdown_at`. */
export type GotoArgs = {
    target_x: number;
    target_y: number;
    reward: number;
    ttl_seconds: number;
};

/**
 * Parse and validate raw arguments for `request_goto` / `request_putdown_at`.
 *
 * @param json Raw (unknown) input, expected to be an object.
 * @returns The typed `GotoArgs`, or `{ error }` describing the first validation failure.
 */
export function parseGotoArgs(json: unknown): GotoArgs | { error: string } {
    if (typeof json !== "object" || json === null) return { error: "args must be an object" };
    const obj = json as Record<string, unknown>;
    const target_x   = coerceNum(obj.target_x);
    const target_y   = coerceNum(obj.target_y);
    const reward     = coerceNum(obj.reward);
    const ttl_seconds = coerceNum(obj.ttl_seconds);
    if (typeof target_x   !== "number" || !Number.isInteger(target_x))   return { error: "target_x must be an integer" };
    if (typeof target_y   !== "number" || !Number.isInteger(target_y))   return { error: "target_y must be an integer" };
    if (typeof reward     !== "number" || reward <= 0)     return { error: "reward must be a positive number" };
    if (typeof ttl_seconds !== "number" || !Number.isInteger(ttl_seconds) || ttl_seconds < 5 || ttl_seconds > 120)
        return { error: "ttl_seconds must be an integer in [5, 120]" };
    return { target_x, target_y, reward, ttl_seconds };
}


/** Arguments for `register_scoring_rule`. */
export type ScoringRuleArgs = {
    id: string;
    conditioned_axis: "stack_count" | "delivery_tile" | "parcel_value";
    // stack_count predicate
    equals?: number;
    min?: number;
    max?: number;
    // delivery_tile
    tile_x?: number;
    tile_y?: number;
    // parcel_value predicate
    min_reward?: number;
    max_reward?: number;
    // effect
    multiplier?: number;
    additive?: number;
};

/**
 * Parse and validate raw arguments for `register_scoring_rule`.
 *
 * @param json Raw (unknown) input, expected to be an object.
 * @returns The typed `ScoringRuleArgs`, or `{ error }` describing the first validation failure.
 */
export function parseScoringRuleArgs(json: unknown): ScoringRuleArgs | { error: string } {
    if (typeof json !== "object" || json === null) return { error: "args must be an object" };
    const obj = json as Record<string, unknown>;

    const id = obj.id;
    if (typeof id !== "string" || id.trim() === "") return { error: "id must be a non-empty string" };

    const conditioned_axis = obj.conditioned_axis;
    if (conditioned_axis !== "stack_count" && conditioned_axis !== "delivery_tile" && conditioned_axis !== "parcel_value")
        return { error: "conditioned_axis must be one of: stack_count, delivery_tile, parcel_value" };

    const multiplier = coerceNum(obj.multiplier);
    const additive   = coerceNum(obj.additive);
    if (multiplier !== undefined && (typeof multiplier !== "number" || multiplier < 0))
        return { error: "multiplier must be a non-negative number" };
    if (additive !== undefined && (typeof additive !== "number" || Math.abs(additive as number) > 1000))
        return { error: "additive must be a number with |additive| ≤ 1000" };
    if (multiplier === undefined && additive === undefined)
        return { error: "at least one of multiplier or additive is required" };

    if (conditioned_axis === "stack_count") {
        const equals = coerceNum(obj.equals);
        const min    = coerceNum(obj.min);
        const max    = coerceNum(obj.max);
        if (equals === undefined && min === undefined && max === undefined)
            return { error: "stack_count axis requires at least one of: equals, min, max" };
        if (equals !== undefined && (typeof equals !== "number" || !Number.isInteger(equals) || equals < 1))
            return { error: "equals must be a positive integer" };
        if (min !== undefined && (typeof min !== "number" || !Number.isInteger(min) || min < 1))
            return { error: "min must be a positive integer" };
        if (max !== undefined && (typeof max !== "number" || !Number.isInteger(max) || max < 1))
            return { error: "max must be a positive integer" };
        return { id, conditioned_axis, equals: equals as number | undefined, min: min as number | undefined, max: max as number | undefined, multiplier: multiplier as number | undefined, additive: additive as number | undefined };
    }

    if (conditioned_axis === "delivery_tile") {
        const tile_x = coerceNum(obj.tile_x);
        const tile_y = coerceNum(obj.tile_y);
        if (typeof tile_x !== "number" || !Number.isInteger(tile_x)) return { error: "tile_x must be an integer" };
        if (typeof tile_y !== "number" || !Number.isInteger(tile_y)) return { error: "tile_y must be an integer" };
        return { id, conditioned_axis, tile_x, tile_y, multiplier: multiplier as number | undefined, additive: additive as number | undefined };
    }

    // parcel_value
    const min_reward = coerceNum(obj.min_reward);
    const max_reward = coerceNum(obj.max_reward);
    if (min_reward === undefined && max_reward === undefined)
        return { error: "parcel_value axis requires at least one of: min_reward, max_reward" };
    if (min_reward !== undefined && (typeof min_reward !== "number" || min_reward < 0))
        return { error: "min_reward must be a non-negative number" };
    if (max_reward !== undefined && (typeof max_reward !== "number" || max_reward < 0))
        return { error: "max_reward must be a non-negative number" };
    return { id, conditioned_axis, min_reward: min_reward as number | undefined, max_reward: max_reward as number | undefined, multiplier: multiplier as number | undefined, additive: additive as number | undefined };
}


/** Arguments for the `request_rendezvous` LLM tool (validated on the proposing side). */
export type RendezvousArgs = {
    x: number;
    y: number;
    max_distance: number;
    reward: number;
};

export function parseRendezvousArgs(json: unknown): RendezvousArgs | { error: string } {
    if (typeof json !== "object" || json === null) return { error: "args must be an object" };
    const obj = json as Record<string, unknown>;
    const x            = coerceNum(obj.x);
    const y            = coerceNum(obj.y);
    const max_distance = coerceNum(obj.max_distance);
    const reward       = coerceNum(obj.reward);
    if (typeof x !== "number" || !Number.isInteger(x)) return { error: "x must be an integer" };
    if (typeof y !== "number" || !Number.isInteger(y)) return { error: "y must be an integer" };
    if (typeof max_distance !== "number" || !Number.isInteger(max_distance) || max_distance < 0 || max_distance > 10)
        return { error: "max_distance must be an integer in [0, 10]" };
    if (typeof reward !== "number" || reward <= 0) return { error: "reward must be a positive number" };
    return { x, y, max_distance, reward };
}

/** Wire args for `rendezvous_propose` and `rendezvous_commit` (same shape, includes rid). */
export type RendezvousProposeArgs = RendezvousArgs & { rid: string };

export function parseRendezvousProposeArgs(json: unknown): RendezvousProposeArgs | { error: string } {
    const base = parseRendezvousArgs(json);
    if ("error" in base) return base;
    const obj = json as Record<string, unknown>;
    if (typeof obj.rid !== "string" || obj.rid.trim() === "") return { error: "rid must be a non-empty string" };
    return { ...base, rid: obj.rid };
}

/** Wire args for `rendezvous_vote`. */
export type RendezvousVoteArgs = { rid: string; accept: boolean };

export function parseRendezvousVoteArgs(json: unknown): RendezvousVoteArgs | { error: string } {
    if (typeof json !== "object" || json === null) return { error: "args must be an object" };
    const obj = json as Record<string, unknown>;
    if (typeof obj.rid !== "string" || obj.rid.trim() === "") return { error: "rid must be a non-empty string" };
    if (typeof obj.accept !== "boolean") return { error: "accept must be a boolean" };
    return { rid: obj.rid, accept: obj.accept };
}


/** Arguments for `request_red_light`. */
export type RedLightArgs = {
    ttl_seconds: number;
    reward: number;
    axis: "row" | "column";
    parity: "odd" | "even";
};

export function parseRedLightArgs(json: unknown): RedLightArgs | { error: string } {
    if (typeof json !== "object" || json === null) return { error: "args must be an object" };
    const obj = json as Record<string, unknown>;
    const reward      = coerceNum(obj.reward);
    const ttl_seconds = coerceNum(obj.ttl_seconds);
    if (typeof reward !== "number" || reward <= 0) return { error: "reward must be a positive number" };
    if (typeof ttl_seconds !== "number" || !Number.isInteger(ttl_seconds) || ttl_seconds < 5 || ttl_seconds > 120)
        return { error: "ttl_seconds must be an integer in [5, 120]" };
    const axis   = obj.axis   ?? "row";
    const parity = obj.parity ?? "odd";
    if (axis !== "row" && axis !== "column") return { error: "axis must be 'row' or 'column'" };
    if (parity !== "odd" && parity !== "even") return { error: "parity must be 'odd' or 'even'" };
    return { ttl_seconds, reward, axis, parity };
}


/** Wire args for `red_light_propose` and `red_light_commit` (same shape as RedLightArgs, plus rid). */
export type RedLightProposeArgs = RedLightArgs & { rid: string };

export function parseRedLightProposeArgs(json: unknown): RedLightProposeArgs | { error: string } {
    const base = parseRedLightArgs(json);
    if ("error" in base) return base;
    const obj = json as Record<string, unknown>;
    if (typeof obj.rid !== "string" || obj.rid.trim() === "") return { error: "rid must be a non-empty string" };
    return { ...base, rid: obj.rid };
}


/** Arguments for `register_traversal_penalty`. */
export type TraversalPenaltyArgs = {
    id: string;
    target_x: number;
    target_y: number;
    cost: number
};

/**
 * Parse and validate raw arguments for `register_traversal_penalty`.
 *
 * @param json Raw (unknown) input, expected to be an object.
 * @returns The typed `TraversalPenaltyArgs`, or `{ error }` describing the first validation failure.
 */
export function parseTraversalPenaltyArgs(json: unknown): TraversalPenaltyArgs | { error: string } {
    if (typeof json !== "object" || json === null) return { error: "args must be an object" };
    const obj = json as Record<string, unknown>;
    if (typeof obj.id !== "string" || obj.id.trim() === "") return { error: "id must be a non-empty string" };
    const target_x = coerceNum(obj.target_x);
    const target_y = coerceNum(obj.target_y);
    const cost     = coerceNum(obj.cost);
    if (typeof target_x !== "number" || !Number.isInteger(target_x)) return { error: "target_x must be an integer" };
    if (typeof target_y !== "number" || !Number.isInteger(target_y)) return { error: "target_y must be an integer" };
    if (typeof cost !== "number" || cost < 0 || cost > 1000) return { error: "cost must be a number in [0, 1000]" };
    return { id: obj.id, target_x, target_y, cost };
}


/** Arguments for `assign_strategy` (the `agent_id`/`rationale` fields are handled by the tool handler). */
export type AssignStrategyArgs = {
    strategy: StrategyType;
    role: StrategyRole;
    tile_x: number;
    tile_y: number;
    max_distance: number;
    ttl_seconds: number;
    bonus?: number;
    partner_id?: string;
    /** HANDOFF/PICKUP_AGENT: spawn-cluster centroid to camp; tile_x/y remains the drop midpoint. */
    pickup_zone_x?: number;
    pickup_zone_y?: number;
};

const STRATEGY_TYPES: ReadonlySet<string> = new Set(Object.values(StrategyType));
const STRATEGY_ROLES: ReadonlySet<string> = new Set(Object.values(StrategyRole));

export function parseAssignStrategyArgs(json: unknown): AssignStrategyArgs | { error: string } {
    if (typeof json !== "object" || json === null) return { error: "args must be an object" };
    const obj = json as Record<string, unknown>;

    if (typeof obj.strategy !== "string" || !STRATEGY_TYPES.has(obj.strategy))
        return { error: `strategy must be one of: ${[...STRATEGY_TYPES].join(", ")}` };
    if (typeof obj.role !== "string" || !STRATEGY_ROLES.has(obj.role))
        return { error: `role must be one of: ${[...STRATEGY_ROLES].join(", ")}` };

    const tile_x       = coerceNum(obj.tile_x);
    const tile_y       = coerceNum(obj.tile_y);
    const max_distance = coerceNum(obj.max_distance);
    const ttl_seconds  = coerceNum(obj.ttl_seconds);
    const bonus        = coerceNum(obj.bonus);
    if (typeof tile_x !== "number" || !Number.isInteger(tile_x)) return { error: "tile_x must be an integer" };
    if (typeof tile_y !== "number" || !Number.isInteger(tile_y)) return { error: "tile_y must be an integer" };
    if (typeof max_distance !== "number" || !Number.isInteger(max_distance) || max_distance < 0 || max_distance > 10)
        return { error: "max_distance must be an integer in [0, 10]" };
    if (typeof ttl_seconds !== "number" || !Number.isInteger(ttl_seconds) || ttl_seconds < 5 || ttl_seconds > 120)
        return { error: "ttl_seconds must be an integer in [5, 120]" };
    if (bonus !== undefined && (typeof bonus !== "number" || bonus < 0))
        return { error: "bonus must be a non-negative number" };

    const partner_id = typeof obj.partner_id === "string" && obj.partner_id.trim() !== "" ? obj.partner_id : undefined;
    if (obj.strategy === StrategyType.Handoff && partner_id === undefined)
        return { error: "partner_id is required for HANDOFF strategy" };

    const pickup_zone_x = coerceNum(obj.pickup_zone_x);
    const pickup_zone_y = coerceNum(obj.pickup_zone_y);
    const hasPickupZone = pickup_zone_x !== undefined && pickup_zone_y !== undefined;
    if (hasPickupZone && (typeof pickup_zone_x !== "number" || !Number.isInteger(pickup_zone_x)))
        return { error: "pickup_zone_x must be an integer" };
    if (hasPickupZone && (typeof pickup_zone_y !== "number" || !Number.isInteger(pickup_zone_y)))
        return { error: "pickup_zone_y must be an integer" };

    return {
        strategy: obj.strategy as StrategyType,
        role: obj.role as StrategyRole,
        tile_x, tile_y, max_distance, ttl_seconds,
        bonus: bonus as number | undefined,
        partner_id,
        pickup_zone_x: hasPickupZone ? pickup_zone_x as number : undefined,
        pickup_zone_y: hasPickupZone ? pickup_zone_y as number : undefined,
    };
}
