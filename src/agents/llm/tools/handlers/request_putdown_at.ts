import OpenAI from "openai";
import type { ToolContext } from "../context.js";
import { TILE_TYPE } from "../../../../models/tile_type.js";
import { parseGotoArgs } from "../../../../models/tool_args.js";
import { communicate } from "../../communication/communicate.js";

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

/**
 * Execute the "request_putdown_at" tool by parsing the input arguments, validating them, and then adding a new REACH_TILE desire with a putdown action to the agent's intention stack. Returns a JSON string indicating success or containing an error message if execution failed.
 * @param rawArgs The raw arguments to the tool, expected to be an object with properties as defined in the Args type
 * @param ctx The tool context, which provides access to beliefs and a method for adding new intentions
 * @returns A JSON string containing { ok: true } if the intention was successfully added, or { error: string } if there was a problem with the input arguments, the target tile, or if the agent is not currently carrying any parcels
 */
export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const parsed = parseGotoArgs(rawArgs);
    if ("error" in parsed) return JSON.stringify({ error: parsed.error });

    const { target_x, target_y, reward, ttl_seconds } = parsed;
    const map = ctx.beliefs.map.getMap();
    if (!map) return JSON.stringify({ error: "Map not yet loaded" });
    if (!ctx.beliefs.map.checkMapBounds(target_x, target_y)) return JSON.stringify({ error: "Coordinates out of map bounds" });
    if (map.tiles[target_y][target_x] === TILE_TYPE.WALL)
        return JSON.stringify({ error: "Target tile is a wall" });
    if (ctx.beliefs.map.isBlocked({ x: target_x, y: target_y }))
        return JSON.stringify({ error: "Target tile is currently blocked" });

    const expiresAt = Date.now() + ttl_seconds * 1_000;
    ctx.addInjectedIntention({
        desire: { type: "DELIVER_PARCEL", target: { x: target_x, y: target_y }, bonus: reward },
        expiresAt,
        sourceId: ctx.sourceId,
    });
    await communicate(ctx, "request_putdown_at", parsed as unknown as Record<string, unknown>);
    return JSON.stringify({ ok: true });
}
