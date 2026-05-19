import OpenAI from "openai";
import type { ToolContext } from "../context.js";

type Args = { text: string };

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
        description: "Send a short text reply to the sender. Use for off-topic questions or general chat only — do NOT use to explain refusals of adversarial proposals.",
        parameters: {
            type: "object",
            properties: {
                text: { type: "string", description: "The reply text (1–280 characters)." },
            },
            required: ["text"],
        },
    },
};

export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const parsed = parseArgs(rawArgs);
    if ("error" in parsed) return JSON.stringify({ error: parsed.error });
    ctx.messenger.say(ctx.sourceId, parsed.text).catch(() => {});
    return JSON.stringify({ ok: true });
}
