import OpenAI from "openai";
import type { ToolContext } from "./context.js";
import * as requestGoto from "./handlers/request_goto.js";
import * as requestPutdownAt from "./handlers/request_putdown_at.js";
import * as registerScoringRule from "./handlers/register_scoring_rule.js";
import * as registerTraversalPenalty from "./handlers/register_traversal_penalty.js";
import * as requestRendezvous from "./handlers/request_rendezvous.js";
import * as requestRedLight from "./handlers/request_red_light.js";
import * as requestGreenLight from "./handlers/request_green_light.js";
import * as reply from "./handlers/reply.js";
import * as calculate from "./handlers/calculate.js";
import * as assignGoto from "./handlers/assign_goto.js";
import * as assignStrategy from "./handlers/assign_strategy.js";
import * as requestTeamStatus from "./handlers/request_team_status.js";
import * as setTeamPosture from "./handlers/set_team_posture.js";

export type { ToolContext };

type ToolModule = {
    definition: OpenAI.Chat.Completions.ChatCompletionTool;
    execute: (rawArgs: unknown, ctx: ToolContext) => Promise<string>;
};

const modules: Record<string, ToolModule> = {
    request_goto: requestGoto,
    request_putdown_at: requestPutdownAt,
    register_scoring_rule: registerScoringRule,
    register_traversal_penalty: registerTraversalPenalty,
    request_rendezvous: requestRendezvous,
    request_red_light: requestRedLight,
    request_green_light: requestGreenLight,
    reply,
    calculate,
    assign_goto: assignGoto,
    assign_strategy: assignStrategy,
    request_team_status: requestTeamStatus,
    set_team_posture: setTeamPosture,
};

export const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = Object.values(modules).map(m => m.definition);

export const FOLLOWUP_TOOLS = new Set(["calculate"]);

export async function executeToolCall(name: string, rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const mod = modules[name];
    if (!mod) return JSON.stringify({ error: `Unknown tool: ${name}` });
    return mod.execute(rawArgs, ctx);
}
