import OpenAI from "openai";
import type { ToolContext } from "../context.js";

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
 * Handler for the `request_rendezvous` tool. Runs a two-phase commit protocol: the LLM agent
 * proposes the rendezvous to all current peers, collects value-aware votes, then commits
 * (injecting HOLD_TILE for all) or aborts (no holds injected) based on unanimity.
 */
export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    if (!ctx.proposeRendezvous) return JSON.stringify({ error: "rendezvous not available in this mode" });
    return ctx.proposeRendezvous(rawArgs);
}
