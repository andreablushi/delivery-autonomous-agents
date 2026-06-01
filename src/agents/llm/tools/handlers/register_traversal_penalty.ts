import OpenAI from "openai";
import type { ToolContext } from "../context.js";
import { applyInjection } from "../../../../models/apply_injection.js";
import { communicate } from "../../communication/communicate.js";


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
    const r = applyInjection("register_traversal_penalty", rawArgs, ctx);
    if ("error" in r) return JSON.stringify(r);
    await communicate(ctx, "register_traversal_penalty", rawArgs as Record<string, unknown>);
    return JSON.stringify({ ok: true });
}
