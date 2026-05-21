import OpenAI from "openai";
import type { ToolContext } from "../context.js";

type Args = { text: string };

/**
 * Try to parse the raw arguments as the expected Args type, and return an error message if parsing fails.
 * @param json The raw arguments to parse
 * @returns The parsed Args object, or an object with an "error" property if parsing failed
 */
function parseArgs(json: unknown): Args | { error: string } {
    if (typeof json !== "object" || json === null) return { error: "args must be an object" };
    const obj = json as Record<string, unknown>;
    const { text } = obj;
    if (typeof text !== "string" || text.trim().length === 0)
        return { error: "text must be a non-empty string" };
    if (text.length > 280)
        return { error: "text must be 280 characters or fewer" };
    return { text };
}

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "reply",
        description: "Send a short text reply to the admin. Use for greetings, factual answers, math results, or any message that does not require navigation.",
        parameters: {
            type: "object",
            properties: {
                text: { type: "string", description: "The reply text (1–280 characters)." },
            },
            required: ["text"],
        },
    },
};

/**
 * Execute the "reply" tool by parsing the input arguments, validating them, and then sending the specified text message back to the sender using the messenger. Returns a JSON string indicating success or containing an error message if execution failed.
 * @param rawArgs The raw arguments to the tool, expected to be an object with a "text" string property
 * @param ctx The tool context, which provides access to the messenger for sending the reply
 * @returns A JSON string containing { ok: true } if the reply was successfully sent, or { error: string } if there was a problem with the input arguments
 */
export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const parsed = parseArgs(rawArgs);
    if ("error" in parsed) return JSON.stringify({ error: parsed.error });
    ctx.messenger.say(ctx.sourceId, parsed.text).catch(() => {});
    return JSON.stringify({ ok: true });
}
