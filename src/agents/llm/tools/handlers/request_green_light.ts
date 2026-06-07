import OpenAI from "openai";
import { PeerKind } from "../../../../models/message_injection.js";
import { makeInjectionExecute } from "./_injection_handler.js";

export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "request_green_light",
        description: "Green light: cancel any active HOLD_TILE on both agents and let them resume normal operation.",
        parameters: { type: "object", properties: {}, required: [] },
    },
};

// Broadcasts empty args — RequestResume carries no parameters.
export const execute = makeInjectionExecute(PeerKind.RequestResume, () => ({}));
