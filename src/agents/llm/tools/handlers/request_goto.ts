import OpenAI from "openai";
import type { ToolContext } from "../context.js";
import { applyInjection } from "../../../../models/apply_injection.js";
import { PeerKind } from "../../../../models/message_injection.js";

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "request_goto",
        description: "Register a temporary navigation goal. The agent will navigate to the target tile if it is valid, walkable, and not currently hazardous.",
        parameters: {
            type: "object",
            properties: {
                target_x: { type: "integer", description: "X coordinate of the target tile." },
                target_y: { type: "integer", description: "Y coordinate of the target tile." },
                reward: { type: "integer", description: "Reward value for this goal (can be negative to penalise reaching the tile)." },
                ttl_seconds: { type: "integer", description: "How many seconds this goal stays active (5–120)." },
            },
            required: ["target_x", "target_y", "reward", "ttl_seconds"],
        },
    },
};

/**
 * Execute the "request_goto" tool by parsing the input arguments, validating them, and then adding a new PARK_TILE desire to the agent's intention stack. Returns a JSON string indicating success or containing an error message if execution failed.
 * @param rawArgs The raw arguments to the tool, expected to be an object with properties as defined in the Args type
 * @param ctx The tool context, which provides access to beliefs and a method for adding new intentions
 * @returns A JSON string containing { ok: true } if the intention was successfully added, or { error: string } if there was a problem with the input arguments or the target tile
 */
export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const r = applyInjection(PeerKind.RequestGoto, rawArgs, ctx);
    if ("error" in r) return JSON.stringify(r);
    await ctx.comm.broadcast(PeerKind.RequestGoto, rawArgs as Record<string, unknown>);
    return JSON.stringify({ ok: true });
}
