import OpenAI from "openai";
import type { ToolContext } from "../context.js";
import { applyInjection } from "../../../../models/apply_injection.js";

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "request_green_light",
        description: "Green light: cancel any active HOLD_TILE on both agents and let them resume normal operation.",
        parameters: { type: "object", properties: {}, required: [] },
    },
};

/**
 * Handler for the `request_green_light` tool. Removes any active HOLD_TILE intentions and communicates the resume request to the peer.
 * @param rawArgs The raw arguments passed to the tool (expected to be an empty object).
 * @param ctx The tool context, providing access to beliefs, intentions, and communication.
 * @returns A JSON string indicating success.
 */
export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const r = applyInjection("request_resume", rawArgs, ctx);
    if ("error" in r) return JSON.stringify(r);
    await ctx.comm.broadcast("request_resume", {});
    return JSON.stringify({ ok: true });
}
