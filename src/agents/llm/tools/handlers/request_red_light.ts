import OpenAI from "openai";
import type { ToolContext } from "../context.js";
import { parseRedLightArgs } from "../../../../models/tool_args.js";
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
    const parsed = parseRedLightArgs(rawArgs);
    if ("error" in parsed) return JSON.stringify({ error: parsed.error });

    const { ttl_seconds, reward } = parsed;

    const from = ctx.beliefs.agents.getCurrentPosition();
    if (!from) return JSON.stringify({ error: "Agent position not yet known" });

    const tile = ctx.beliefs.map.pickOddRowTile(from);
    if (!tile) return JSON.stringify({ error: "No odd-row tile reachable" });

    const expiresAt = Date.now() + ttl_seconds * 1_000;
    ctx.addInjectedIntention({
        desire: { type: "HOLD_TILE", target: tile, sourceId: ctx.sourceId, expiresAt, reward },
        expiresAt,
        sourceId: ctx.sourceId,
    });

    await communicate(ctx, "request_red_light", parsed as unknown as Record<string, unknown>);
    return JSON.stringify({ ok: true, myTile: tile });
}
