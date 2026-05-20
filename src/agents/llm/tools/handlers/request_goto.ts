import OpenAI from "openai";
import type { ToolContext } from "../context.js";
import { TILE_TYPE } from "../../../../models/tile_type.js";

export type Args = {
    target_x: number;
    target_y: number;
    reward: number;
    ttl_seconds: number;
};

function coerceInt(v: unknown): unknown {
    return typeof v === "string" && v.trim() !== "" ? Number(v) : v;
}

export function parseArgs(json: unknown): Args | { error: string } {
    if (typeof json !== "object" || json === null) return { error: "args must be an object" };
    const obj = json as Record<string, unknown>;
    const target_x = coerceInt(obj.target_x);
    const target_y = coerceInt(obj.target_y);
    const reward = coerceInt(obj.reward);
    const ttl_seconds = coerceInt(obj.ttl_seconds);
    if (typeof target_x !== "number" || !Number.isInteger(target_x))
        return { error: "target_x must be an integer" };
    if (typeof target_y !== "number" || !Number.isInteger(target_y))
        return { error: "target_y must be an integer" };
    if (typeof reward !== "number" || !Number.isInteger(reward) || reward < 1)
        return { error: "reward must be an integer >= 1" };
    if (typeof ttl_seconds !== "number" || !Number.isInteger(ttl_seconds) || ttl_seconds < 5 || ttl_seconds > 120)
        return { error: "ttl_seconds must be an integer in [5, 120]" };
    return { target_x, target_y, reward, ttl_seconds };
}

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "request_goto",
        description: "Register a temporary navigation goal. The agent will navigate to the target tile if it is valid, walkable, and not currently hazardous.",
        parameters: {
            type: "object",
            properties: {
                target_x: { type: "integer", description: "X coordinate of the target tile." },
                target_y: { type: "integer", description: "Y coordinate of the target tile." },
                reward: { type: "integer", description: "Reward value for this goal." },
                ttl_seconds: { type: "integer", description: "How many seconds this goal stays active (5–120)." },
            },
            required: ["target_x", "target_y", "reward", "ttl_seconds"],
        },
    },
};

export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const parsed = parseArgs(rawArgs);
    if ("error" in parsed) return JSON.stringify({ error: parsed.error });

    const { target_x, target_y, reward, ttl_seconds } = parsed;
    const map = ctx.beliefs.map.getMap();
    if (!map) return JSON.stringify({ error: "Map not yet loaded" });
    if (target_x < 0 || target_x >= map.width || target_y < 0 || target_y >= map.height)
        return JSON.stringify({ error: "Coordinates out of map bounds" });
    if (map.tiles[target_y][target_x] === TILE_TYPE.WALL)
        return JSON.stringify({ error: "Target tile is a wall" });
    if (ctx.beliefs.map.isBlocked({ x: target_x, y: target_y }))
        return JSON.stringify({ error: "Target tile is currently blocked" });

    const expiresAt = Date.now() + ttl_seconds * 1_000;
    ctx.addPersistentDesire({
        desire: { type: "REACH_TILE", target: { x: target_x, y: target_y }, sourceId: ctx.sourceId, expiresAt, reward },
        expiresAt,
        sourceId: ctx.sourceId,
    });
    return JSON.stringify({ ok: true });
}
