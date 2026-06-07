import OpenAI from "openai";
import type { ToolContext } from "../context.js";
import { applyInjection } from "../../../../models/apply_injection.js";
import { PeerKind } from "../../../../models/message_injection.js";
import { parseAssignStrategyArgs } from "../../../../models/injection_args.js";
import { StrategyType, StrategyRole } from "../../../../models/game_strategy.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("coordination");

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "assign_strategy",
        description: "Assign a cooperation role to an agent (yourself or a teammate). For yourself it is applied locally; for a teammate an assign_strategy message is sent. PICKUP_AGENT collects parcels in its spawn zone, travels to the midpoint, and drops them. DELIVER_AGENT waits at the midpoint, picks up the grounded parcels, delivers them, and returns.",
        parameters: {
            type: "object",
            properties: {
                agent_id:     { type: "string",  description: "ID of the agent to assign (use your own id to assign yourself)." },
                strategy:     { type: "string",  enum: Object.values(StrategyType), description: "Strategy to assign." },
                role:         { type: "string",  enum: Object.values(StrategyRole), description: "PICKUP_AGENT or DELIVER_AGENT." },
                tile_x:       { type: "integer", description: "X of the HANDOFF midpoint tile (meet zone center)." },
                tile_y:       { type: "integer", description: "Y of the HANDOFF midpoint tile (meet zone center)." },
                max_distance: { type: "integer", description: "Hold-zone radius around the tile (0–10)." },
                bonus:        { type: "integer", description: "Cross-agent delivery bonus to weight the handoff decision (omit if none)." },
                ttl_seconds:  { type: "integer", description: "How long the strategy stays active (5–120; default 30 = coordination interval)." },
                partner_id:   { type: "string",  description: "HANDOFF only: the teammate this agent pairs with." },
                rationale:    { type: "string",  description: "One line explaining why this assignment (logged only; does not affect behaviour)." },
            },
            required: ["agent_id", "strategy", "role", "tile_x", "tile_y", "max_distance", "ttl_seconds"],
        },
    },
};

/**
 * Assign a cooperation strategy to a specific agent (self or teammate).
 * Self → applied locally via applyInjection; teammate → sent as an assign_strategy message.
 * The `rationale` field is logging-only.
 */
export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    if (typeof rawArgs !== "object" || rawArgs === null) return JSON.stringify({ error: "args must be an object" });
    const obj = rawArgs as Record<string, unknown>;
    const agent_id = obj.agent_id;
    if (typeof agent_id !== "string" || agent_id.trim() === "") return JSON.stringify({ error: "agent_id must be a non-empty string" });

    const parsed = parseAssignStrategyArgs(rawArgs);
    if ("error" in parsed) return JSON.stringify({ error: parsed.error });

    const rationale = typeof obj.rationale === "string" ? obj.rationale.trim() : "";
    if (rationale) log.debug(`assign_strategy ${parsed.strategy}/${parsed.role} → ${agent_id}: ${rationale}`);

    // Strip self/log-only fields before applying or forwarding.
    const args = {
        strategy: parsed.strategy, role: parsed.role,
        tile_x: parsed.tile_x, tile_y: parsed.tile_y,
        max_distance: parsed.max_distance, ttl_seconds: parsed.ttl_seconds,
        bonus: parsed.bonus, partner_id: parsed.partner_id,
    };

    const me = ctx.beliefs.agents.getCurrentMe();
    if (agent_id === me?.id) {
        const r = applyInjection(PeerKind.AssignStrategy, args, ctx);
        if ("error" in r) return JSON.stringify(r);
    } else {
        if (!ctx.beliefs.agents.getTeammateIds().has(agent_id)) return JSON.stringify({ error: `Agent ${agent_id} is not a known teammate` });
        // The tile is a hold-ZONE center, not a step target — it need not be walkable itself
        // (allRendezvousTiles snaps to reachable tiles within max_distance). Only require bounds.
        if (!ctx.beliefs.map.getMap()) return JSON.stringify({ error: "Map not yet loaded" });
        if (!ctx.beliefs.map.checkMapBounds(parsed.tile_x, parsed.tile_y)) return JSON.stringify({ error: "Coordinates out of map bounds" });
        await ctx.comm.send(agent_id, PeerKind.AssignStrategy, args);
    }

    return JSON.stringify({ ok: true, agent_id, strategy: parsed.strategy, role: parsed.role });
}
