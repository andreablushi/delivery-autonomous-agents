import OpenAI from "openai";
import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { PersistentDesireEntry } from "../../../models/intentions.js";
import type { Messenger } from "../../bdi/communication/messenger.js";
import { TOOLS, FOLLOWUP_TOOLS, executeToolCall } from "../tools/index.js";
import { buildSystemPrompt, buildUserMessage, summarizeBeliefs } from "../prompt/prompt.js";
import { createLogger, type Logger } from "../../../utils/logger.js";

export class LLMClient {
    private readonly client: OpenAI;
    private readonly model: string;
    private readonly log: Logger;
    private readonly addPersistentDesire: (entry: PersistentDesireEntry) => void;
    private readonly messenger: Messenger;

    constructor(
        addPersistentDesire: (entry: PersistentDesireEntry) => void,
        messenger: Messenger,
        agentId?: string,
    ) {
        this.client = new OpenAI({
            baseURL: process.env.LLM_BASE_URL,
            apiKey: process.env.LLM_API_KEY ?? "no-key",
        });
        this.model = process.env.MODEL_NAME ?? "llama-3.3-70b-lmstudio";
        this.log = createLogger("llm", agentId);
        this.addPersistentDesire = addPersistentDesire;
        this.messenger = messenger;
    }

    async processMessage(
        senderId: string,
        senderName: string,
        content: string,
        beliefs: Readonly<Beliefs>,
    ): Promise<void> {
        const ctx = {
            beliefs: beliefs as Beliefs,
            addPersistentDesire: this.addPersistentDesire,
            messenger: this.messenger,
            sourceId: senderId,
        };

        const context = summarizeBeliefs(beliefs);
        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: buildUserMessage({ senderName, senderId, content, context }) },
        ];
        this.log.debug(`Processing message from ${senderId}: "${content}"`);

        const MAX_HOPS = 4;
        for (let hop = 0; hop < MAX_HOPS; hop++) {
            const response = await this.client.chat.completions.create({
                model: this.model,
                messages,
                tools: TOOLS,
                tool_choice: "auto",
                temperature: 0.1,
            });

            const choice = response.choices[0];
            if (!choice) break;

            const toolCalls = choice.message.tool_calls ?? [];
            if (toolCalls.length === 0) break;

            messages.push(choice.message);

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
