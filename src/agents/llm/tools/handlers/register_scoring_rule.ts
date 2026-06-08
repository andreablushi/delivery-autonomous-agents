import OpenAI from "openai";
import { PeerKind } from "../../../../models/message_injection.js";
import { SCORING_AXIS } from "../../../../models/rules.js";
import { makeInjectionExecute } from "./_injection_handler.js";


export const definition: OpenAI.Chat.Completions.ChatCompletionTool = {
    type: "function",
    function: {
        name: "register_scoring_rule",
        description: "Register (or replace) a persistent scoring rule that reweights desire scoring each deliberation cycle. Three axis types: stack_count (modifies DELIVER_PARCEL score when carrying N parcels), delivery_tile (modifies score for a specific delivery tile), parcel_value (modifies per-parcel contribution based on its reward). Re-registering with the same id replaces the previous rule.",
        parameters: {
            type: "object",
            properties: {
                id:               { type: "string",  description: "Unique identifier for this rule. Re-registering with the same id replaces the previous rule." },
                conditioned_axis: { type: "string",  enum: Object.values(SCORING_AXIS), description: "Which dimension this rule applies to." },
                equals:      { type: "integer", description: "(stack_count only) Exact carried-parcel count to match." },
                min:         { type: "integer", description: "(stack_count only) Minimum carried-parcel count to match." },
                max:         { type: "integer", description: "(stack_count only) Maximum carried-parcel count to match." },
                tile_x:      { type: "integer", description: "(delivery_tile only) X coordinate of the target delivery tile." },
                tile_y:      { type: "integer", description: "(delivery_tile only) Y coordinate of the target delivery tile." },
                min_reward:  { type: "number",  description: "(parcel_value only) Match parcels with reward ≥ this value." },
                max_reward:  { type: "number",  description: "(parcel_value only) Match parcels with reward ≤ this value." },
                multiplier:  { type: "number",  description: "Score multiplier (must be ≥ 0; 0 zeroes out matching desires)." },
                additive:    { type: "number",  description: "Flat additive bonus/penalty applied after the multiplier (|additive| ≤ 1000)." },
            },
            required: ["id", "conditioned_axis"],
        },
    },
};

export const execute = makeInjectionExecute(PeerKind.RegisterScoringRule);
