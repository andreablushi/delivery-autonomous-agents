import OpenAI from "openai";
import type { ToolContext } from "../context.js";
import { applyInjection } from "../../../../models/apply_injection.js";
import { communicate } from "../../communication/communicate.js";

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "request_rendezvous",
        description: "Navigate both agents to within `max_distance` tiles of (x, y) and hold position until both are in the zone. The hold auto-releases once both agents are confirmed inside the zone — no green light needed.",
        parameters: {
            type: "object",
            properties: {
                x: { type: "integer", description: "X coordinate of the rendezvous centre." },
                y: { type: "integer", description: "Y coordinate of the rendezvous centre." },
                max_distance: { type: "integer", description: "Maximum Manhattan distance from (x,y) each agent may hold at (0–10)." },
                reward: { type: "integer", description: "Priority reward for this goal (default 100)." },
            },
            required: ["x", "y", "max_distance", "reward"],
        },
    },
};

/**
 * Handler for the `request_rendezvous` tool. Validates arguments, checks preconditions, injects a HOLD_TILE desire with a release zone, and communicates the request to the peer.
 * @param rawArgs The raw arguments passed to the tool (expected to be an object with x, y, max_distance, reward).
 * @param ctx The tool context, providing access to beliefs, intentions, and communication.
 * @returns A JSON string indicating success or error details.
 */
export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const r = applyInjection("request_rendezvous", rawArgs, ctx);
    if ("error" in r) return JSON.stringify(r);
    // Peer independently enumerates its own candidate tiles via allRendezvousTiles.
    await communicate(ctx, "request_rendezvous", rawArgs as Record<string, unknown>);
    return JSON.stringify({ ok: true });
}
