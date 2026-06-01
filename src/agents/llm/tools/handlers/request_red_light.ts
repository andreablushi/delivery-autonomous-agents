import OpenAI from "openai";
import type { ToolContext } from "../context.js";
import { applyInjection } from "../../../../models/apply_injection.js";
import { communicate } from "../../communication/communicate.js";

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "request_red_light",
        description: "Red light: navigate both agents to the nearest tile with an odd row number (y % 2 === 1) and hold indefinitely. Use request_green_light to resume.",
        parameters: {
            type: "object",
            properties: {
                reward: { type: "integer", description: "Priority reward for this goal (default 100)." },
                ttl_seconds: { type: "integer", description: "Maximum seconds to hold before auto-expiry (5–120)." },
            },
            required: ["reward", "ttl_seconds"],
        },
    },
};

/**
 * Handler for the `request_red_light` tool. Validates arguments, checks preconditions, injects a HOLD_TILE desire targeting the nearest odd-row tile, and communicates the request to the peer.
 * @param rawArgs The raw arguments passed to the tool (expected to be an object with reward and ttl_seconds).
 * @param ctx The tool context, providing access to beliefs, intentions, and communication.
 * @returns A JSON string indicating success or error details.
 */
export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const r = applyInjection("request_red_light", rawArgs, ctx);
    if ("error" in r) return JSON.stringify(r);
    await communicate(ctx, "request_red_light", rawArgs as Record<string, unknown>);
    return JSON.stringify({ ok: true });
}
