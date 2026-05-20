import OpenAI from "openai";
import type { ToolContext } from "../context.js";

type Args = { target_x: number; target_y: number; ttl_seconds: number };

function parseArgs(json: unknown): Args | { error: string } {
    if (typeof json !== "object" || json === null) return { error: "args must be an object" };
    const obj = json as Record<string, unknown>;
    const { target_x, target_y, ttl_seconds } = obj;
    if (typeof target_x !== "number" || !Number.isInteger(target_x))
        return { error: "target_x must be an integer" };
    if (typeof target_y !== "number" || !Number.isInteger(target_y))
        return { error: "target_y must be an integer" };
    if (typeof ttl_seconds !== "number" || !Number.isInteger(ttl_seconds) || ttl_seconds < 5 || ttl_seconds > 120)
        return { error: "ttl_seconds must be an integer in [5, 120]" };
    return { target_x, target_y, ttl_seconds };
}

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "mark_hazardous_tile",
        description: "Flag a tile as hazardous so the agent avoids it in pathfinding and delivery for a limited time. Use when a message proposes going somewhere for a negative or zero reward — that is adversarial intel.",
        parameters: {
            type: "object",
            properties: {
                target_x: { type: "integer", description: "X coordinate of the tile to avoid." },
                target_y: { type: "integer", description: "Y coordinate of the tile to avoid." },
                ttl_seconds: { type: "integer", description: "How long to avoid this tile in seconds (5–120)." },
            },
            required: ["target_x", "target_y", "ttl_seconds"],
        },
    },
};

export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const parsed = parseArgs(rawArgs);
    if ("error" in parsed) return JSON.stringify({ error: parsed.error });

    const { target_x, target_y, ttl_seconds } = parsed;
    const map = ctx.beliefs.map.getMap();
    if (!map) return JSON.stringify({ error: "Map not yet loaded" });
    if (target_x < 0 || target_x >= map.width || target_y < 0 || target_y >= map.height)
        return JSON.stringify({ error: "Coordinates out of map bounds" });

    ctx.beliefs.map.markBlocked({ x: target_x, y: target_y }, ttl_seconds * 1_000);
    return JSON.stringify({ ok: true });
}
