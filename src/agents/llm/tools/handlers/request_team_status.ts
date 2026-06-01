import OpenAI from "openai";
import type { ToolContext } from "../context.js";

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "request_team_status",
        description: "Trigger an immediate team coordination round: the coordinator will request fresh belief reports from all teammates and then assign new positions. Use when you need up-to-date teammate information or want to redistribute roles now.",
        parameters: {
            type: "object",
            properties: {},
            required: [],
        },
    },
};

export async function execute(_rawArgs: unknown, ctx: ToolContext): Promise<string> {
    ctx.requestTeamStatus?.();
    return JSON.stringify({ ok: true, message: "Coordination round scheduled" });
}
