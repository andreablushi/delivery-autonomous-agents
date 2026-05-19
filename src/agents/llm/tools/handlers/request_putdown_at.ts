import OpenAI from "openai";
import type { ToolContext } from "../context.js";
import { TILE_TYPE } from "../../../../models/tile_type.js";
import { parseArgs } from "./request_goto.js";

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "request_putdown_at",
        description: "Navigate to the target tile and drop all carried parcels on arrival. Only useful when carrying at least one parcel.",
        parameters: {
            type: "object",
            properties: {
                target_x: { type: "integer", description: "X coordinate of the target tile." },
                target_y: { type: "integer", description: "Y coordinate of the target tile." },
                reward: { type: "integer", description: "Reward value for this goal (1–100)." },
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
        desire: { type: "DELIVER_PARCEL", target: { x: target_x, y: target_y }, bonus: reward },
        expiresAt,
        sourceId: ctx.sourceId,
    });
    return JSON.stringify({ ok: true });
}
