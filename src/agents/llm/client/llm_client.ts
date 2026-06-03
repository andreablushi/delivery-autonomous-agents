import OpenAI from "openai";
import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { InjectedIntention } from "../../../models/intentions.js";
import type { Communication } from "../../communication/communication.js";
import type { RuleStore } from "../../bdi/belief/rule_store.js";
import { TOOLS, FOLLOWUP_TOOLS, executeToolCall } from "../tools/index.js";
import { buildSystemPrompt, buildUserMessage } from "../prompt/main/index.js";
import { buildCoordinationPrompt } from "../prompt/coordination/index.js";
import type { BeliefsReport } from "../../../models/message_injection.js";
import type { TeamGeometry } from "../coordination/geometry.js";
import { createLogger, type Logger } from "../../../utils/logger.js";
import { config } from "../../../config.js";

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
    private readonly removeIntentionsByType: (type: import("../../../models/desires.js").DesireType["type"]) => void;
    private readonly comm: Communication;
    private readonly ruleStore: RuleStore;
    private readonly proposeRendezvous: (rawArgs: unknown) => Promise<string>;

    constructor(
        addInjectedIntention: (entry: InjectedIntention) => void,
        removeIntentionsByType: (type: import("../../../models/desires.js").DesireType["type"]) => void,
        comm: Communication,
        ruleStore: RuleStore,
        proposeRendezvous: (rawArgs: unknown) => Promise<string>,
        agentId?: string,
    ) {
        this.client = new OpenAI({
            baseURL: process.env.LLM_BASE_URL,
            apiKey: process.env.LLM_API_KEY ?? "no-key",
            timeout: config.llm.timeoutMs,
        });
        this.model = process.env.MODEL_NAME ?? "llama-3.3-70b-lmstudio";
        this.log = createLogger("llm", agentId);
        this.promptLog = createLogger("llm-prompt", agentId);
        this.addInjectedIntention = addInjectedIntention;
        this.removeIntentionsByType = removeIntentionsByType;
        this.comm = comm;
        this.ruleStore = ruleStore;
        this.proposeRendezvous = proposeRendezvous;
    }

    /**
     * Shared multi-hop tool-call loop used by both processMessage and coordinate.
     */
    private async runHops(
        messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        ctx: import("../tools/context.js").ToolContext,
    ): Promise<void> {
        for (let hop = 0; hop < config.llm.maxHops; hop++) {
            this.log.debug(`LLM call, hop ${hop}...`);
            const response = await this.client.chat.completions.create({
                model: this.model,
                messages,
                tools: TOOLS,
                tool_choice: "auto",
                temperature: 0.1,
            });
            this.log.debug(`LLM response received (hop ${hop})`);

            const choice = response.choices[0];
            this.promptLog.debug(`LLM response (hop ${hop}): ${JSON.stringify(choice)}`);
            if (!choice) break;

            const toolCalls = choice.message.tool_calls ?? [];
            if (toolCalls.length === 0) {
                const text = choice.message.content?.trim();
                if (!text) break;
                const textCall = tryParseTextToolCall(text);
                if (textCall) {
                    this.log.debug(`Text tool call [hop ${hop}]: ${textCall.name}(${JSON.stringify(textCall.args)})`);
                    const result = await executeToolCall(textCall.name, textCall.args, ctx);
                    this.log.debug(`Tool result [hop ${hop}]: ${result}`);
                    if (!FOLLOWUP_TOOLS.has(textCall.name)) break;
                    messages.push({ role: "assistant", content: text });
                    messages.push({ role: "user", content: `Tool result: ${result}` });
                    continue;
                }
                this.log.debug(`No tool calls — sending model text as chat reply`);
                await executeToolCall("reply", { text: text.slice(0, config.llm.replyMaxChars) }, ctx);
                break;
            }

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
        const ctx = {
            beliefs: beliefs as Beliefs,
            addInjectedIntention: this.addInjectedIntention,
            removeIntentionsByType: this.removeIntentionsByType,
            comm: this.comm,
            sourceId: senderId,
            ruleStore: this.ruleStore,
            proposeRendezvous: this.proposeRendezvous,
        };

        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: "system", content: buildSystemPrompt() },
            { role: "user", content: buildUserMessage({ senderName, senderId, content, beliefs, ruleStore: this.ruleStore }) },
        ];
        this.log.debug(`Processing message from ${senderName}: "${content}"`);
        await this.runHops(messages, ctx);
    }

    /**
     * Run a team coordination pass: the LLM is given teammate reports + map geometry
     * and expected to call `assign_goto` for each agent.
     */
    async coordinate(
        reports: Map<string, BeliefsReport>,
        geometry: TeamGeometry,
        beliefs: Readonly<Beliefs>,
        requestTeamStatus: () => void,
    ): Promise<void> {
        const ctx = {
            beliefs: beliefs as Beliefs,
            addInjectedIntention: this.addInjectedIntention,
            removeIntentionsByType: this.removeIntentionsByType,
            comm: this.comm,
            sourceId: "coordinator",
            ruleStore: this.ruleStore,
            requestTeamStatus,
        };

        const { system, user } = buildCoordinationPrompt(reports, geometry, beliefs, this.ruleStore);
        const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
            { role: "system", content: system },
            { role: "user", content: user },
        ];
        this.log.debug("Running coordination pass");
        await this.runHops(messages, ctx);
    }
}
