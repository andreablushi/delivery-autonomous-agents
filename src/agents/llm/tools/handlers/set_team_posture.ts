import OpenAI from "openai";
import type { ToolContext } from "../context.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("coordination");

const POSTURES = ["ZONAL_RELAY", "OPPORTUNISTIC", "NONE"] as const;

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "set_team_posture",
        description:
            "Choose the team's cooperation mode. The system deterministically assigns roles — " +
            "no coordinates needed from you.\n" +
            "  ZONAL_RELAY  — one agent (PICKUP) sweeps the full spawn region, drops at the " +
            "spawn-side edge tile. The other (DELIVER) waits there, ferries parcels to real " +
            "delivery tiles, returns. Best when spawns are clustered on one map side.\n" +
            "  OPPORTUNISTIC — arms both agents for handpass mode. Both search autonomously. " +
            "The first to pick up a parcel initiates a 2PC handshake: both converge on the " +
            "midpoint between them and wait for each other; the initiator drops its parcels " +
            "there; the partner collects and delivers. Disarms automatically after one cycle. " +
            "Best when spawns are scattered and a cross-agent bonus is active. Set the bonus arg.\n" +
            "  NONE    — let agents run autonomously; current assignments lapse on their TTL.\n" +
            "The assignment refreshes automatically each coordination cycle.",
        parameters: {
            type: "object",
            properties: {
                posture: {
                    type: "string",
                    enum: [...POSTURES],
                    description: "Team posture to apply.",
                },
                bonus: {
                    type: "integer",
                    description: "Cross-agent delivery bonus — only relevant for HANDOFF and SPREAD.",
                },
                rationale: {
                    type: "string",
                    description: "One-line reason for this choice (logged only; has no effect on behaviour).",
                },
            },
            required: ["posture"],
        },
    },
};

export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    if (typeof rawArgs !== "object" || rawArgs === null)
        return JSON.stringify({ error: "args must be an object" });
    const obj = rawArgs as Record<string, unknown>;

    const posture = obj.posture;
    if (typeof posture !== "string" || !POSTURES.includes(posture as (typeof POSTURES)[number]))
        return JSON.stringify({ error: `posture must be one of: ${POSTURES.join(", ")}` });

    const bonus = typeof obj.bonus === "number" ? Math.round(obj.bonus) : undefined;
    const rationale = typeof obj.rationale === "string" ? obj.rationale.trim() : "";
    if (rationale) log.debug(`set_team_posture ${posture}: ${rationale}`);

    if (!ctx.assignPosture)
        return JSON.stringify({ error: "set_team_posture is only available in a coordination context" });

    return ctx.assignPosture(posture, { bonus });
}
