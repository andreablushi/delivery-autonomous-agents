import OpenAI from "openai";
import type { ToolContext } from "../context.js";

type Args = { id: string };

function parseArgs(json: unknown): Args | { error: string } {
    if (typeof json !== "object" || json === null) return { error: "args must be an object" };
    const obj = json as Record<string, unknown>;
    if (typeof obj.id !== "string" || obj.id.trim() === "") return { error: "id must be a non-empty string" };
    return { id: obj.id };
}

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "remove_scoring_rule",
        description: "Remove an active scoring rule by id. Has no effect if no rule with that id exists.",
        parameters: {
            type: "object",
            properties: {
                id: { type: "string", description: "The id of the rule to remove." },
            },
            required: ["id"],
        },
    },
};

export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const parsed = parseArgs(rawArgs);
    if ("error" in parsed) return JSON.stringify({ error: parsed.error });
    const removed = ctx.ruleStore.remove(parsed.id);
    return JSON.stringify({ ok: true, removed });
}
