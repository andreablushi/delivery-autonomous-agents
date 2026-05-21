import OpenAI from "openai";
import type { ToolContext } from "../context.js";
import { parseRendezvousArgs } from "../../../../models/tool_args.js";
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
    const parsed = parseRendezvousArgs(rawArgs);
    if ("error" in parsed) return JSON.stringify({ error: parsed.error });

    const { x, y, max_distance, reward } = parsed;
    if (!ctx.beliefs.map.checkMapBounds(x, y)) return JSON.stringify({ error: "Coordinates out of map bounds" });

    const from = ctx.beliefs.agents.getCurrentPosition();
    if (!from) return JSON.stringify({ error: "Agent position not yet known" });

    const tile = ctx.beliefs.map.pickRendezvousTile(from, x, y, max_distance);
    if (!tile) return JSON.stringify({ error: "No reachable tile within rendezvous zone" });

    ctx.addInjectedIntention({
        desire: {
            type: "HOLD_TILE",
            target: tile,
            sourceId: ctx.sourceId,
            reward,
            releaseZone: { center: { x, y }, maxDistance: max_distance },
        },
        sourceId: ctx.sourceId,
    });

    // Include our tile as excluded so the peer picks a different spot in the zone.
    await communicate(ctx, "request_rendezvous", {
        ...(parsed as unknown as Record<string, unknown>),
        excluded_x: tile.x,
        excluded_y: tile.y,
    });
    await communicate(ctx, "rendezvous_position", { x: tile.x, y: tile.y });
    return JSON.stringify({ ok: true, myTile: tile });
}
