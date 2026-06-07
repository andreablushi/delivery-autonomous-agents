import OpenAI from "openai";
import { PeerKind } from "../../../../models/message_injection.js";
import { makeInjectionExecute } from "./_injection_handler.js";


/**
 * Tool definition for the "register_traversal_penalty" tool, which allows the agent to register a soft penalty on stepping onto a specific tile. This can be used to influence the agent's pathfinding without making the tile completely impassable.
 * The LLM should call this tool when it wants to discourage the agent from stepping onto a certain tile, and can specify a cost that makes the agent prefer detours if the cost exceeds the detour length.
 */
export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "register_traversal_penalty",
        description: "Register (or replace) a soft traversal cost on a tile. The agent's A* planner will add this cost when considering stepping onto the tile, making it prefer detours when the penalty exceeds the detour length. Unlike hazard blocking this does NOT make the tile impassable. Re-registering with the same id replaces the previous penalty.",
        parameters: {
            type: "object",
            properties: {
                id:       { type: "string",  description: "Unique identifier. Re-registering with the same id replaces the previous penalty." },
                target_x: { type: "integer", description: "X coordinate of the tile to penalise." },
                target_y: { type: "integer", description: "Y coordinate of the tile to penalise." },
                cost:     { type: "number",  description: "Additional path cost when stepping onto this tile (0–1000). A cost greater than any detour length effectively makes the tile avoided." },
            },
            required: ["id", "target_x", "target_y", "cost"],
        },
    },
};

export const execute = makeInjectionExecute(PeerKind.RegisterTraversalPenalty);
