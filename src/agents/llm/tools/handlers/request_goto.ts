import OpenAI from "openai";
import { PeerKind } from "../../../../models/message_injection.js";
import { makeInjectionExecute } from "./_injection_handler.js";

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "request_goto",
        description: "Register a temporary navigation goal. The agent will navigate to the target tile if it is valid, walkable, and not currently hazardous.",
        parameters: {
            type: "object",
            properties: {
                target_x: { type: "integer", description: "X coordinate of the target tile." },
                target_y: { type: "integer", description: "Y coordinate of the target tile." },
                reward: { type: "integer", description: "Reward value for this goal (can be negative to penalise reaching the tile)." },
                ttl_seconds: { type: "integer", description: "How many seconds this goal stays active (5–120)." },
            },
            required: ["target_x", "target_y", "reward", "ttl_seconds"],
        },
    },
};

export const execute = makeInjectionExecute(PeerKind.RequestGoto);
