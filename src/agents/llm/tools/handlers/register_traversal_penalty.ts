import OpenAI from "openai";
import type { ToolContext } from "../context.js";
import { coerceNum, checkMapBounds } from "./utils.js";

type Args = { id: string; target_x: number; target_y: number; cost: number };

/**
 * Try to parse the raw arguments as the expected Args type, and return an error message if parsing fails.
 * @param json The raw arguments to parse
 * @returns The parsed Args object, or an object with an "error" property if parsing failed
 */
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

/**
 * Tool definition for the "register_traversal_penalty" tool, which allows the agent to register a soft penalty on stepping onto a specific tile. This can be used to influence the agent's pathfinding without making the tile completely impassable.
 * The LLM should call this tool when it wants to discourage the agent from stepping onto a certain tile, and can specify a cost that makes the agent prefer detours if the cost exceeds the detour length.
 */
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

/**
 * Execute the "register_traversal_penalty" tool by parsing the input arguments, validating them, and then upserting the new scoring rule into the rule store. Returns a JSON string indicating success or containing an error message if execution failed.
 * @param rawArgs The raw arguments to the tool, expected to be an object with properties as defined in the Args type
 * @param ctx The tool context, which provides access to beliefs and the rule store for registering the new rule
 * @returns A JSON string containing { ok: true } if the rule was successfully registered, or { error: string } if there was a problem with the input arguments
 */
export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const parsed = parseArgs(rawArgs);
    if ("error" in parsed) return JSON.stringify({ error: parsed.error });

    const { id, target_x, target_y, cost } = parsed;
    const mapResult = checkMapBounds(ctx, target_x, target_y);
    if ("error" in mapResult) return JSON.stringify({ error: mapResult.error });

    ctx.beliefs.map.setTilePenalty(id, { x: target_x, y: target_y }, cost);
    return JSON.stringify({ ok: true });
}
