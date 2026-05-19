import OpenAI from "openai";
import type { ToolContext } from "../context.js";

type Args = { query: string };

function parseArgs(json: unknown): Args | { error: string } {
    if (typeof json !== "object" || json === null) return { error: "args must be an object" };
    const obj = json as Record<string, unknown>;
    const { query } = obj;
    if (typeof query !== "string" || query.trim().length === 0)
        return { error: "query must be a non-empty string" };
    return { query: query.trim() };
}

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "web_search",
        description: "Search the web for factual information and return a brief summary. Use when the sender asks a factual question you cannot answer from context (e.g. 'capital of France', 'who invented the telephone'). After receiving the result, call reply to send the answer.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "The search query (max 200 characters)." },
            },
            required: ["query"],
        },
    },
};

export async function execute(rawArgs: unknown, _ctx: ToolContext): Promise<string> {
    const parsed = parseArgs(rawArgs);
    if ("error" in parsed) return JSON.stringify({ error: parsed.error });
    try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(parsed.query)}&format=json&no_html=1&skip_disambig=1`;
        const resp = await fetch(url);
        if (!resp.ok) return JSON.stringify({ error: `Search request failed: ${resp.status}` });
        const data = await resp.json() as Record<string, unknown>;
        const answer = (data["AbstractText"] as string | undefined)
            || (data["Answer"] as string | undefined)
            || "";
        if (!answer) return JSON.stringify({ result: "No information found for that query." });
        return JSON.stringify({ result: answer.slice(0, 500) });
    } catch {
        return JSON.stringify({ error: "Web search failed" });
    }
}
