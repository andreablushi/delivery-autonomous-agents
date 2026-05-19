import OpenAI from "openai";
import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { PersistentDesireEntry } from "../../../models/intentions.js";
import { TOOLS, executeToolCall } from "../tools/tools.js";
import { buildSystemPrompt, buildUserMessage } from "../prompt/prompt.js";
import { createLogger, type Logger } from "../../../utils/logger.js";

export class LLMClient {
    private readonly client: OpenAI;
    private readonly model: string;
    private readonly log: Logger;
    private readonly addPersistentDesire: (entry: PersistentDesireEntry) => void;

    /**
     * Generic LLM client that processes incoming messages, constructs prompts with current beliefs as context, and handles tool calls from the LLM response.
     * @param addPersistentDesire Callback function to add a persistent desire to the BDI agent's intention queue.
     * @param agentId Optional agent ID for logging purposes.
     */
    constructor(addPersistentDesire: (entry: PersistentDesireEntry) => void, agentId?: string) {
        this.client = new OpenAI({
            baseURL: process.env.LLM_BASE_URL,
            apiKey: process.env.LLM_API_KEY ?? "no-key",
        });
        this.model = process.env.MODEL_NAME ?? "llama-3.3-70b-lmstudio";
        this.log = createLogger("llm", agentId);
        this.addPersistentDesire = addPersistentDesire;
    }

    async processMessage(
        senderId: string,
        senderName: string,
        content: string,
        beliefs: Readonly<Beliefs>,
    ): Promise<void> {
        //TODO: implement actual context later
        const context = "PLACEHOLDER";
        
        // Construct the prompt with the message and current beliefs as context, then call the LLM.
        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: buildUserMessage({ senderName, senderId, content, context }) },
        ];
        this.log.debug(`Processing message from ${senderId}: "${content}"`);
        
        // Retrieve the response from the LLM, which may include tool calls
        const response = await this.client.chat.completions.create({
            model: this.model,
            messages,
            tools: TOOLS,
            tool_choice: "auto",
            temperature: 0.1,
        });
        const choice = response.choices[0];
        if (!choice) return;

        // Parse and execute any tool calls included in the LLM response
        for (const call of choice.message.tool_calls ?? []) {
            if (call.type !== "function") continue;
            let args: unknown;
            try {
                args = JSON.parse(call.function.arguments);
            } catch {
                args = {};
            }
            this.log.debug(`Tool call: ${call.function.name}(${call.function.arguments})`);
            const result = executeToolCall(call.function.name, args, beliefs, this.addPersistentDesire, senderId);
            this.log.debug(`Tool result: ${result}`);
        }
    }
}
