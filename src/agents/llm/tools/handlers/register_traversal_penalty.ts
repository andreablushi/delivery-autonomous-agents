import OpenAI from "openai";
import type { ToolContext } from "../context.js";

type Args = { id: string; target_x: number; target_y: number; cost: number };

function coerceNum(v: unknown): unknown {
    return typeof v === "string" && v.trim() !== "" ? Number(v) : v;
}

function parseArgs(json: unknown): Args | { error: string } {
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

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "register_traversal_penalty",
        description: "Register (or replace) a soft traversal cost on a tile. The agent's A* planner will add this cost when considering stepping onto the tile, making it prefer detours when the penalty exceeds the detour length. Unlike hazard blocking this does NOT make the tile impassable. Re-registering with the same id replaces the previous penalty.",
        parameters: {
            type: "object",
            properties: {
                id:       { type: "string",  description: "Unique identifier. Re-registering with the same id replaces the previous penalty." },
                target_x: { type: "integer", description: "X coordinate of the tile to penalise." },
                target_y: { type: "integer", description: "Y coordinate of the tile to penalise." },
                cost:     { type: "number",  description: "Additional path cost when stepping onto this tile (0–1000). A cost greater than any detour length effectively makes the tile avoided." },
            },
            required: ["id", "target_x", "target_y", "cost"],
        },
    },
};

export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const parsed = parseArgs(rawArgs);
    if ("error" in parsed) return JSON.stringify({ error: parsed.error });

    const { id, target_x, target_y, cost } = parsed;
    const map = ctx.beliefs.map.getMap();
    if (!map) return JSON.stringify({ error: "Map not yet loaded" });
    if (target_x < 0 || target_x >= map.width || target_y < 0 || target_y >= map.height)
        return JSON.stringify({ error: "Coordinates out of map bounds" });

    ctx.beliefs.map.setTilePenalty(id, { x: target_x, y: target_y }, cost);
    return JSON.stringify({ ok: true });
}
