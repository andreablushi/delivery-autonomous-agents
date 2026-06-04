import OpenAI from "openai";
import type { ToolContext } from "../context.js";
import { createLogger } from "../../../../utils/logger.js";

const log = createLogger("coordination");

const POSTURES = ["SPREAD", "MIDFIELD", "HANDOFF", "NONE"] as const;

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "set_team_posture",
        description:
            "Choose the team's coordination posture. The system deterministically assigns each agent " +
            "to the best matching anchor based on proximity — no coordinates needed from you.\n" +
            "  SPREAD   — each agent camps a different spawn cluster centroid, collects in-zone " +
            "parcels, and hands them off to a DELIVER partner at the midpoint when the zone empties.\n" +
            "  MIDFIELD — each agent holds a midpoint between a spawn and delivery zone and " +
            "self-delivers any parcels it collects there.\n" +
            "  HANDOFF  — one agent picks up parcels freely, the other waits at the midpoint to " +
            "receive them and deliver for the cross-agent bonus (set bonus arg).\n" +
            "  NONE     — let agents run autonomously; current assignments lapse on their TTL.\n" +
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
