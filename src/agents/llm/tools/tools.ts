import OpenAI from "openai";
import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { PersistentDesireEntry } from "../../../models/intentions.js";
import { parseRequestGotoArgs } from "./types.js";
import { TILE_TYPE } from "../../../models/tile_type.js";

export const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "request_goto",
            description:
                "Register a temporary navigation goal. The agent will navigate to the target tile if it is valid and walkable.",
            parameters: {
                type: "object",
                properties: {
                    target_x: { type: "integer", description: "X coordinate of the target tile." },
                    target_y: { type: "integer", description: "Y coordinate of the target tile." },
                    reward: { type: "integer", description: "Reward value for this goal (1–100)." },
                    ttl_seconds: {
                        type: "integer",
                        description: "How many seconds this goal stays active (5–120).",
                    },
                },
                required: ["target_x", "target_y", "reward", "ttl_seconds"],
            },
        },
    },
];

export function executeToolCall(
    name: string,
    rawArgs: unknown,
    beliefs: Beliefs,
    addPersistentDesire: (entry: PersistentDesireEntry) => void,
    sourceId: string,
): string {
    if (name !== "request_goto")
        return JSON.stringify({ error: `Unknown tool: ${name}` });

    const parsed = parseRequestGotoArgs(rawArgs);
    if ("error" in parsed) return JSON.stringify({ error: parsed.error });

    const { target_x, target_y, reward, ttl_seconds } = parsed;
    const map = beliefs.map.getMap();
    if (!map) return JSON.stringify({ error: "Map not yet loaded" });

    if (target_x < 0 || target_x >= map.width || target_y < 0 || target_y >= map.height)
        return JSON.stringify({ error: "Coordinates out of map bounds" });
    if (map.tiles[target_y][target_x] === TILE_TYPE.WALL)
        return JSON.stringify({ error: "Target tile is a wall" });

    addPersistentDesire({
        desire: {
            type: "REACH_TILE",
            target: { x: target_x, y: target_y },
            sourceId,
            expiresAt: Date.now() + ttl_seconds * 1_000,
            reward,
        },
        expiresAt: Date.now() + ttl_seconds * 1_000,
        sourceId,
    });
    return JSON.stringify({ ok: true });
}
