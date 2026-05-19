import OpenAI from "openai";
import type { ToolContext } from "./context.js";
import * as requestGoto from "./handlers/request_goto.js";
import * as requestPutdownAt from "./handlers/request_putdown_at.js";
import * as markHazardousTile from "./handlers/mark_hazardous_tile.js";
import * as reply from "./handlers/reply.js";
import * as calculate from "./handlers/calculate.js";
import * as webSearch from "./handlers/web_search.js";

export type { ToolContext };

type ToolModule = {
    definition: OpenAI.Chat.Completions.ChatCompletionTool;
    execute: (rawArgs: unknown, ctx: ToolContext) => Promise<string>;
};

const modules: Record<string, ToolModule> = {
    request_goto: requestGoto,
    request_putdown_at: requestPutdownAt,
    mark_hazardous_tile: markHazardousTile,
    reply,
    calculate,
    web_search: webSearch,
};

export const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = Object.values(modules).map(m => m.definition);

export const FOLLOWUP_TOOLS = new Set(["calculate", "web_search"]);

export async function executeToolCall(name: string, rawArgs: unknown, ctx: ToolContext): Promise<string> {
    const mod = modules[name];
    if (!mod) return JSON.stringify({ error: `Unknown tool: ${name}` });
    return mod.execute(rawArgs, ctx);
}
