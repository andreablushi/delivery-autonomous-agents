import OpenAI from "openai";
import type { ToolContext } from "../context.js";

type Args = { id: string };

/**
 * Try to parse the raw arguments as the expected Args type, and return an error message if parsing fails.
 * @param json The raw arguments to parse
 * @returns The parsed Args object, or an object with an "error" property if parsing failed
 */
function parseArgs(json: unknown): Args | { error: string } {
    if (typeof json !== "object" || json === null) return { error: "args must be an object" };
    const obj = json as Record<string, unknown>;
    if (typeof obj.id !== "string" || obj.id.trim() === "") return { error: "id must be a non-empty string" };
    return { id: obj.id };
}

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "remove_traversal_penalty",
        description: "Remove a soft traversal penalty by id. Has no effect if no penalty with that id exists.",
        parameters: {
            type: "object",
            properties: {
                id: { type: "string", description: "The id of the traversal penalty to remove." },
            },
            required: ["id"],
        },
    },
};

/**
 * Execute the "remove_traversal_penalty" tool by parsing the input arguments, validating them, and then removing the specified traversal penalty from the beliefs. Returns a JSON string indicating success or containing an error message if execution failed.
 * @param rawArgs The raw arguments to the tool, expected to be an object with an "id" string property
 * @param ctx The tool context, which provides access to beliefs for removing the specified traversal penalty
 * @returns A JSON string containing { ok: true } if the penalty was successfully removed (or did not exist), or { error: string } if there was a problem with the input arguments
 */
export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const parsed = parseArgs(rawArgs);
    if ("error" in parsed) return JSON.stringify({ error: parsed.error });
    const removed = ctx.beliefs.map.removeTilePenalty(parsed.id);
    return JSON.stringify({ ok: true, removed });
}
