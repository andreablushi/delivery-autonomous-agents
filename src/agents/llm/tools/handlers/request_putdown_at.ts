import OpenAI from "openai";
import { PeerKind } from "../../../../models/message_injection.js";
import { makeInjectionExecute } from "./_injection_handler.js";

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "request_putdown_at",
        description: "Navigate to the target tile and drop all carried parcels on arrival. Only useful when carrying at least one parcel.",
        parameters: {
            type: "object",
            properties: {
                target_x: { type: "integer", description: "X coordinate of the target tile." },
                target_y: { type: "integer", description: "Y coordinate of the target tile." },
                reward: { type: "integer", description: "Reward value for this goal (1–100)." },
                ttl_seconds: { type: "integer", description: "How many seconds this goal stays active (5–120)." },
            },
            required: ["target_x", "target_y", "reward", "ttl_seconds"],
        },
    },
};

export const execute = makeInjectionExecute(PeerKind.RequestPutdownAt);
