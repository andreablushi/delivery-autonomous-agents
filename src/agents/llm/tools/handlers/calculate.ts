import OpenAI from "openai";
import type { ToolContext } from "../context.js";

type Args = { expression: string };

/**
 * Try to parse the raw arguments as the expected Args type, and return an error message if parsing fails.
 * @param json The raw arguments to parse
 * @returns The parsed Args object, or an object with an "error" property if parsing failed
 */
function parseArgs(json: unknown): Args | { error: string } {
    if (typeof json !== "object" || json === null) return { error: "args must be an object" };
    const obj = json as Record<string, unknown>;
    const { expression } = obj;
    if (typeof expression !== "string" || expression.trim().length === 0)
        return { error: "expression must be a non-empty string" };
    return { expression: expression.trim() };
}

/**
 * Tool definition for the "calculate" tool, which evaluates a mathematical expression and returns the result.
 * The LLM should call this tool when it needs to compute a math expression, and then call reply to send the answer back to the sender.
 */
export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "calculate",
        description: "Evaluate a mathematical expression and return the numeric result. Use when the sender asks you to compute arithmetic or math (e.g. '4*2 + 3', '(10+5)/3'). After receiving the result, call reply to send the answer.",
        parameters: {
            type: "object",
            properties: {
                expression: { type: "string", description: "A mathematical expression using digits, +, -, *, /, **, %, and parentheses." },
            },
            required: ["expression"],
        },
    },
};

/**
 * Execute the "calculate" tool by evaluating the given mathematical expression and returning the result.
 * @param rawArgs The raw arguments to the tool, expected to be an object with an "expression" string property
 * @param _ctx The tool context, which is not used in this tool but may be useful for more complex tools
 * @returns A JSON string containing either the "result" of the calculation or an "error" message if execution failed
 */
export async function execute(rawArgs: unknown, _ctx: ToolContext): Promise<string> {
    const parsed = parseArgs(rawArgs);
    if ("error" in parsed) return JSON.stringify({ error: parsed.error });
    if (!/^[\d\s+\-*/^%().]+$/.test(parsed.expression))
        return JSON.stringify({ error: "Expression contains invalid characters" });
    try {
        // eslint-disable-next-line no-new-func
        const result = Function(`"use strict"; return (${parsed.expression})`)();
        if (typeof result !== "number" || !isFinite(result))
            return JSON.stringify({ error: "Expression did not evaluate to a finite number" });
        return JSON.stringify({ result });
    } catch {
        return JSON.stringify({ error: "Failed to evaluate expression" });
    }
}
