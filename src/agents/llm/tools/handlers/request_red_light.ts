import OpenAI from "openai";
import type { ToolContext } from "../context.js";

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "request_red_light",
        description: "Red light: navigate both agents to the nearest tile on a matching line and hold indefinitely. Default: odd rows (y % 2 === 1). Use axis/parity to stagger by even rows, odd columns, etc. Use request_green_light to resume.",
        parameters: {
            type: "object",
            properties: {
                reward:      { type: "integer", description: "Priority reward for this goal (default 100)." },
                ttl_seconds: { type: "integer", description: "Maximum seconds to hold before auto-expiry (5–120)." },
                axis:        { type: "string",  enum: ["row", "column"], description: "Stagger by row (y) or column (x). Default: row." },
                parity:      { type: "string",  enum: ["odd", "even"],   description: "Target odd or even lines. Default: odd." },
            },
            required: ["reward", "ttl_seconds"],
        },
    },
};

export async function execute(rawArgs: unknown, ctx: ToolContext): Promise<string> {
    if (!ctx.proposeRedLight) return JSON.stringify({ error: "red light not available in this mode" });
    return ctx.proposeRedLight(rawArgs);
}
