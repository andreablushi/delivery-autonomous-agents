import OpenAI from "openai";
import type { ToolContext } from "../context.js";
import type { ScoringRule } from "../../../../models/rules.js";

type Args = {
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

function coerceNum(v: unknown): unknown {
    return typeof v === "string" && v.trim() !== "" ? Number(v) : v;
}

function parseArgs(json: unknown): Args | { error: string } {
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

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "register_scoring_rule",
        description: "Register (or replace) a persistent scoring rule that reweights desire scoring each deliberation cycle. Three axis types: stack_count (modifies DELIVER_PARCEL score when carrying N parcels), delivery_tile (modifies score for a specific delivery tile), parcel_value (modifies per-parcel contribution based on its reward). Re-registering with the same id replaces the previous rule.",
        parameters: {
            type: "object",
            properties: {
                id:               { type: "string",  description: "Unique identifier for this rule. Re-registering with the same id replaces the previous rule." },
                conditioned_axis: { type: "string",  enum: ["stack_count", "delivery_tile", "parcel_value"], description: "Which dimension this rule applies to." },
                equals:      { type: "integer", description: "(stack_count only) Exact carried-parcel count to match." },
                min:         { type: "integer", description: "(stack_count only) Minimum carried-parcel count to match." },
                max:         { type: "integer", description: "(stack_count only) Maximum carried-parcel count to match." },
                tile_x:      { type: "integer", description: "(delivery_tile only) X coordinate of the target delivery tile." },
                tile_y:      { type: "integer", description: "(delivery_tile only) Y coordinate of the target delivery tile." },
                min_reward:  { type: "number",  description: "(parcel_value only) Match parcels with reward ≥ this value." },
                max_reward:  { type: "number",  description: "(parcel_value only) Match parcels with reward ≤ this value." },
                multiplier:  { type: "number",  description: "Score multiplier (must be ≥ 0; 0 zeroes out matching desires)." },
                additive:    { type: "number",  description: "Flat additive bonus/penalty applied after the multiplier (|additive| ≤ 1000)." },
            },
            required: ["id", "conditioned_axis"],
        },
    },
};

export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const parsed = parseArgs(rawArgs);
    if ("error" in parsed) return JSON.stringify({ error: parsed.error });

    const effect = { multiplier: parsed.multiplier, additive: parsed.additive };

    let rule: ScoringRule;
    if (parsed.conditioned_axis === "stack_count") {
        rule = { id: parsed.id, conditioned_axis: "stack_count", registeredAt: 0,
            predicate: { equals: parsed.equals, min: parsed.min, max: parsed.max },
            effect };
    } else if (parsed.conditioned_axis === "delivery_tile") {
        const map = ctx.beliefs.map.getMap();
        if (!map) return JSON.stringify({ error: "Map not yet loaded" });
        const tx = parsed.tile_x!;
        const ty = parsed.tile_y!;
        if (tx < 0 || tx >= map.width || ty < 0 || ty >= map.height)
            return JSON.stringify({ error: "Tile coordinates out of map bounds" });
        rule = { id: parsed.id, conditioned_axis: "delivery_tile", registeredAt: 0,
            tile: { x: tx, y: ty },
            effect };
    } else {
        rule = { id: parsed.id, conditioned_axis: "parcel_value", registeredAt: 0,
            predicate: { minReward: parsed.min_reward, maxReward: parsed.max_reward },
            effect };
    }

    ctx.ruleStore.upsert(rule);
    return JSON.stringify({ ok: true });
}
