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
    if (typeof reward     !== "number" || !Number.isInteger(reward))     return { error: "reward must be an integer" };
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
