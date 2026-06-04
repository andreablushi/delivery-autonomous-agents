import OpenAI from "openai";
import type { ToolContext } from "../context.js";
import { TILE_TYPE } from "../../../../models/tile_type.js";
import { parseGotoArgs, type GotoArgs } from "../../../../models/injection_args.js";

type AssignGotoArgs = { agent_id: string } & GotoArgs;

function parseAssignGotoArgs(json: unknown): AssignGotoArgs | { error: string } {
    if (typeof json !== "object" || json === null) return { error: "args must be an object" };
    const obj = json as Record<string, unknown>;
    if (typeof obj.agent_id !== "string" || obj.agent_id.trim() === "") return { error: "agent_id must be a non-empty string" };
    const rest = parseGotoArgs(json);
    if ("error" in rest) return rest;
    return { agent_id: obj.agent_id, ...rest };
}
import { applyInjection } from "../../../../models/apply_injection.js";
import { PeerKind } from "../../../../models/message_injection.js";

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "assign_goto",
        description: "Send a specific agent (yourself or a known teammate) to a target tile. Use agent_id to address the target agent. For yourself, injects a REACH_TILE goal directly; for a teammate, sends a request_goto message.",
        parameters: {
            type: "object",
            properties: {
                agent_id:    { type: "string",  description: "ID of the agent to assign (use your own id to assign yourself)." },
                target_x:    { type: "integer", description: "X coordinate of the target tile." },
                target_y:    { type: "integer", description: "Y coordinate of the target tile." },
                reward:      { type: "integer", description: "Reward value for this goal (default: 10)." },
                ttl_seconds: { type: "integer", description: "How many seconds this goal stays active (5–120, default: 60)." },
            },
            required: ["agent_id", "target_x", "target_y", "reward", "ttl_seconds"],
        },
    },
};

/**
 * Assign a navigation goal to a specific agent (self or teammate).
 * If agent_id matches this agent's own id, the REACH_TILE desire is injected locally.
 * Otherwise a request_goto message is sent directly to that teammate.
 */
export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const parsed = parseAssignGotoArgs(rawArgs);
    if ("error" in parsed) return JSON.stringify({ error: parsed.error });

    const { agent_id, target_x, target_y, reward, ttl_seconds } = parsed;

    const me = ctx.beliefs.agents.getCurrentMe();
    if (agent_id === me?.id) {
        // Local injection — applyInjection handles all validation (map, bounds, wall, blocked).
        const r = applyInjection(PeerKind.RequestGoto, { target_x, target_y, reward, ttl_seconds }, ctx);
        if ("error" in r) return JSON.stringify(r);
    } else {
        // Remote: validate early to give the LLM useful feedback before proposing.
        const map = ctx.beliefs.map.getMap();
        if (!map) return JSON.stringify({ error: "Map not yet loaded" });
        if (!ctx.beliefs.map.checkMapBounds(target_x, target_y)) return JSON.stringify({ error: "Coordinates out of map bounds" });
        if (map.tiles[target_y][target_x] === TILE_TYPE.WALL) return JSON.stringify({ error: "Target tile is a wall" });
        if (!ctx.beliefs.agents.getTeammateIds().has(agent_id)) return JSON.stringify({ error: `Agent ${agent_id} is not a known teammate` });
        if (!ctx.proposeGoto) return JSON.stringify({ error: "proposeGoto not available in this context" });
        return await ctx.proposeGoto(agent_id, { target_x, target_y, reward, ttl_seconds });
    }

    return JSON.stringify({ ok: true, agent_id, target: { x: target_x, y: target_y } });
}
