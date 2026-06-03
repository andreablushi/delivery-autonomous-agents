import OpenAI from "openai";
import type { ToolContext } from "../context.js";
import { applyInjection } from "../../../../models/apply_injection.js";

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "request_red_light",
        description: "Red light: navigate both agents to the nearest tile on a matching line and hold indefinitely. Default: odd rows (y % 2 === 1). Use axis/parity to stagger by even rows, odd columns, etc. Use request_green_light to resume.",
        parameters: {
            type: "object",
            properties: {
                reward:      { type: "integer", description: "Priority reward for this goal (default 100)." },
                ttl_seconds: { type: "integer", description: "Maximum seconds to hold before auto-expiry (5–120)." },
                axis:        { type: "string",  enum: ["row", "column"], description: "Stagger by row (y) or column (x). Default: row." },
                parity:      { type: "string",  enum: ["odd", "even"],   description: "Target odd or even lines. Default: odd." },
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
    await ctx.comm.broadcast("request_red_light", rawArgs as Record<string, unknown>);
    return JSON.stringify({ ok: true });
}
