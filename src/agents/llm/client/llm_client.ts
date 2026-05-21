import OpenAI from "openai";
import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { InjectedIntention } from "../../../models/intentions.js";
import type { Messenger } from "../../bdi/communication/messenger.js";
import type { RuleStore } from "../../bdi/belief/rule_store.js";
import { TOOLS, FOLLOWUP_TOOLS, executeToolCall } from "../tools/index.js";
import { buildSystemPrompt, buildUserMessage, summarizeBeliefs } from "../prompt/prompt.js";
import { createLogger, type Logger } from "../../../utils/logger.js";

const MAX_HOPS = 5;             // Maximum number of consecutive tool calls before giving up

/**
 * Try to parse a text response as a tool call. 
 * This allows the model to call tools even if it doesn't use the official tool call format.
 * @param text 
 * @returns 
 */
function tryParseTextToolCall(text: string): { name: string; args: unknown } | null {
    try {
        const obj = JSON.parse(text);
        if (obj?.type === "function" && typeof obj.name === "string")
            return { name: obj.name, args: obj.parameters ?? obj.arguments ?? {} };
    } catch { /* not JSON */ }
    return null;
}

export class LLMClient {
    private readonly client: OpenAI;
    private readonly model: string;
    private readonly log: Logger;
    private readonly promptLog: Logger;
    private readonly addInjectedIntention: (entry: InjectedIntention) => void;
    private readonly messenger: Messenger;
    private readonly ruleStore: RuleStore;

    constructor(
        addInjectedIntention: (entry: InjectedIntention) => void,
        messenger: Messenger,
        ruleStore: RuleStore,
        agentId?: string,
    ) {
        this.client = new OpenAI({
            baseURL: process.env.LLM_BASE_URL,
            apiKey: process.env.LLM_API_KEY ?? "no-key",
            timeout: 15_000,
        });
        this.model = process.env.MODEL_NAME ?? "llama-3.3-70b-lmstudio";
        this.log = createLogger("llm-client", agentId);
        this.promptLog = createLogger("llm-prompt", agentId);
        this.addInjectedIntention = addInjectedIntention;
        this.messenger = messenger;
        this.ruleStore = ruleStore;
    }

    /**
     * Process an incoming message by calling the LLM with the message content and current beliefs, and executing any tool calls in the response.
     * @param senderId ID of the message sender (e.g. "ADMIN" or "agent-1")
     * @param senderName Name of the message sender (e.g. "ADMIN" or "agent-1")
     * @param content The message content to process with the LLM
     * @param beliefs Current beliefs to include in the LLM context
     */
    async processMessage(
        senderId: string,
        senderName: string,
        content: string,
        beliefs: Readonly<Beliefs>,
    ): Promise<void> {
        // Define the context object that will be passed to tool calls, 
        // containing relevant information and utilities.
        const ctx = {
            beliefs: beliefs as Beliefs,
            addInjectedIntention: this.addInjectedIntention,
            messenger: this.messenger,
            sourceId: senderId,
            ruleStore: this.ruleStore,
        };

        const context = summarizeBeliefs(beliefs, this.ruleStore);
        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: buildUserMessage({ senderName, senderId, content, context }) },
        ];
        this.log.debug(`Processing message from ${senderName}: "${content}"`);
        
        // Perform multiple hops of LLM calls if the model indicates that follow-up calls are needed
        for (let hop = 0; hop < MAX_HOPS; hop++) {
            this.log.debug(`LLM call, hop ${hop}...`);
            const response = await this.client.chat.completions.create({
                model: this.model,
                messages,
                tools: TOOLS,
                tool_choice: "auto",
                temperature: 0.1,
            });
            this.log.debug(`LLM response received (hop ${hop})`);

            // Log the full prompt and response for debugging purposes
            const choice = response.choices[0];
            this.promptLog.debug(`LLM response (hop ${hop}): ${JSON.stringify(choice)}`);
            if (!choice) break;

            // If the model doesn't use the official tool call format, try to parse the content as a tool call anyway
            const toolCalls = choice.message.tool_calls ?? [];
            if (toolCalls.length === 0) {
                const text = choice.message.content?.trim();    // Trim whitespace to avoid parsing issues
                if (!text) break;
                const textCall = tryParseTextToolCall(text);
                if (textCall) {
                    this.log.debug(`Text tool call [hop ${hop}]: ${textCall.name}(${JSON.stringify(textCall.args)})`);
                    const result = await executeToolCall(textCall.name, textCall.args, ctx);
                    this.log.debug(`Tool result [hop ${hop}]: ${result}`);
                    break;
                }
                this.log.debug(`No tool calls — sending model text as chat reply`);
                await executeToolCall("reply", { text: text.slice(0, 280) }, ctx);
                break;
            }

            // Add the model's message to the conversation history for the next hop
            messages.push(choice.message);

            // Execute all tool calls in the model's response
            let needsFollowUp = false;
            for (const call of toolCalls) {
                if (call.type !== "function") continue;
                let args: unknown;
                try {
                    args = JSON.parse(call.function.arguments);
                } catch {
                    args = {};
                }
                this.log.debug(`Tool call [hop ${hop}]: ${call.function.name}(${call.function.arguments})`);
                const result = await executeToolCall(call.function.name, args, ctx);
                this.log.debug(`Tool result [hop ${hop}]: ${result}`);
                messages.push({ role: "tool", tool_call_id: call.id, content: result });
                if (FOLLOWUP_TOOLS.has(call.function.name)) needsFollowUp = true;
            }

            if (!needsFollowUp) break;
        }
    }
}
