import OpenAI from "openai";
import type { ToolContext } from "./context.js";
import * as requestGoto from "./handlers/request_goto.js";
import * as requestPutdownAt from "./handlers/request_putdown_at.js";
import * as registerScoringRule from "./handlers/register_scoring_rule.js";
import * as removeScoringRule from "./handlers/remove_scoring_rule.js";
import * as registerTraversalPenalty from "./handlers/register_traversal_penalty.js";
import * as removeTraversalPenalty from "./handlers/remove_traversal_penalty.js";
import * as reply from "./handlers/reply.js";
import * as calculate from "./handlers/calculate.js";

export type { ToolContext };

type ToolModule = {
    definition: OpenAI.Chat.Completions.ChatCompletionTool;
    execute: (rawArgs: unknown, ctx: ToolContext) => Promise<string>;
};

const modules: Record<string, ToolModule> = {
    request_goto: requestGoto,
    request_putdown_at: requestPutdownAt,
    register_scoring_rule: registerScoringRule,
    remove_scoring_rule: removeScoringRule,
    register_traversal_penalty: registerTraversalPenalty,
    remove_traversal_penalty: removeTraversalPenalty,
    reply,
    calculate,
};

export const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = Object.values(modules).map(m => m.definition);

export const FOLLOWUP_TOOLS = new Set(["calculate"]);

export async function executeToolCall(name: string, rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const mod = modules[name];
    if (!mod) return JSON.stringify({ error: `Unknown tool: ${name}` });
    return mod.execute(rawArgs, ctx);
}
