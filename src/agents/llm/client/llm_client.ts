import OpenAI from "openai";
import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { InjectedIntention } from "../../../models/intentions.js";
import type { GameStrategy } from "../../../models/game_strategy.js";
import type { Communication } from "../../communication/communication.js";
import type { RuleStore } from "../../bdi/desire/rule_store.js";
import { getTools, FOLLOWUP_TOOLS, executeToolCall } from "../tools/index.js";
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

/**
 * In the coordination pass the model emits one tool call per response, so multi-agent assignment
 * requires looping. Treat assign_goto / assign_strategy as follow-up tools ONLY in the coordinator
 * context, so the loop continues until the LLM stops assigning (then emits a final rationale text).
 */
function isCoordAssign(ctx: import("../tools/context.js").ToolContext, name: string): boolean {
    return ctx.sourceId === "coordinator" && (name === "assign_goto" || name === "assign_strategy");
}

export class LLMClient {
    private readonly client: OpenAI;
    private readonly model: string;
    private readonly log: Logger;
    private readonly promptLog: Logger;
    private readonly addInjectedIntention: (entry: InjectedIntention) => void;
    private readonly removeIntentionsByType: (type: import("../../../models/desires.js").DesireType["type"]) => void;
    private readonly setGameStrategy: (strategy: GameStrategy) => void;
    private readonly getGameStrategy: () => GameStrategy | null;
    private readonly comm: Communication;
    private readonly ruleStore: RuleStore;
    private readonly proposeRendezvous: (rawArgs: unknown) => Promise<string>;
    private readonly proposeRedLight: (rawArgs: unknown) => Promise<string>;
    private readonly proposeGoto: (agentId: string, rawArgs: unknown) => Promise<string>;
    private readonly assignPosture: (posture: string, opts?: { bonus?: number }) => Promise<string>;
    private readonly coordLog: Logger;

    constructor(
        addInjectedIntention: (entry: InjectedIntention) => void,
        removeIntentionsByType: (type: import("../../../models/desires.js").DesireType["type"]) => void,
        setGameStrategy: (strategy: GameStrategy) => void,
        getGameStrategy: () => GameStrategy | null,
        comm: Communication,
        ruleStore: RuleStore,
        proposeRendezvous: (rawArgs: unknown) => Promise<string>,
        proposeRedLight: (rawArgs: unknown) => Promise<string>,
        proposeGoto: (agentId: string, rawArgs: unknown) => Promise<string>,
        assignPosture: (posture: string, opts?: { bonus?: number }) => Promise<string>,
        agentId?: string,
    ) {
        this.client = new OpenAI({
            baseURL: process.env.LLM_BASE_URL,
            apiKey: process.env.LLM_API_KEY ?? "no-key",
            timeout: config.llm.timeoutMs,
        });
        this.model = config.llm.model;
        this.log = createLogger("llm", agentId);
        this.promptLog = createLogger("llm-prompt", agentId);
        this.addInjectedIntention = addInjectedIntention;
        this.removeIntentionsByType = removeIntentionsByType;
        this.setGameStrategy = setGameStrategy;
        this.getGameStrategy = getGameStrategy;
        this.comm = comm;
        this.ruleStore = ruleStore;
        this.proposeRendezvous = proposeRendezvous;
        this.proposeRedLight = proposeRedLight;
        this.proposeGoto = proposeGoto;
        this.assignPosture = assignPosture;
        this.coordLog = createLogger("coordination", agentId);
    }

    /**
     * Shared multi-hop tool-call loop used by both processMessage and coordinate.
     */
    private async runHops(
        messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        ctx: import("../tools/context.js").ToolContext,
        onNoToolText?: (text: string) => void,
    ): Promise<void> {
        for (let hop = 0; hop < config.llm.maxHops; hop++) {
            this.log.debug(`LLM call, hop ${hop}...`);
            const response = await this.client.chat.completions.create({
                model: this.model,
                messages,
                tools: getTools(ctx),
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
                    if (!FOLLOWUP_TOOLS.has(textCall.name) && !isCoordAssign(ctx, textCall.name)) break;
                    messages.push({ role: "assistant", content: text });
                    messages.push({ role: "user", content: `Tool result: ${result}` });
                    continue;
                }
                if (onNoToolText) {
                    // Coordination: the model declined to assign — log its rationale, don't broadcast.
                    onNoToolText(text);
                    break;
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
                // In coordination, assign one agent per hop and loop until the LLM stops — this
                // model emits a single tool call per response, so parallel calls never happen.
                if (FOLLOWUP_TOOLS.has(call.function.name) || isCoordAssign(ctx, call.function.name)) needsFollowUp = true;
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
            setGameStrategy: this.setGameStrategy,
            getGameStrategy: this.getGameStrategy,
            comm: this.comm,
            sourceId: senderId,
            ruleStore: this.ruleStore,
            proposeRendezvous: this.proposeRendezvous,
            proposeRedLight: this.proposeRedLight,
            proposeGoto: this.proposeGoto,
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
     * and responds with a single JSON posture decision. No tool-calling loop — one completion.
     */
    async coordinate(
        reports: Map<string, BeliefsReport>,
        geometry: TeamGeometry,
        beliefs: Readonly<Beliefs>,
        requestTeamStatus: () => void,
        missionNote = "",
    ): Promise<void> {
        const { system, user } = buildCoordinationPrompt(reports, geometry, beliefs, this.ruleStore, missionNote);
        this.log.debug("Running coordination pass");

        const response = await this.client.chat.completions.create({
            model: this.model,
            messages: [
                { role: "system", content: system },
                { role: "user", content: user },
            ],
            temperature: 0.1,
        });

        const text = response.choices[0]?.message.content?.trim() ?? "";
        this.promptLog.debug(`Coordination response: ${text}`);

        // Extract the first {...} block from the response and parse the posture.
        const POSTURES = ["ZONAL_RELAY", "OPPORTUNISTIC", "NONE"] as const;
        type Posture = typeof POSTURES[number];
        let posture: Posture = "NONE";
        let bonus: number | undefined;

        const match = text.match(/\{[\s\S]*?\}/);
        if (match) {
            try {
                const obj = JSON.parse(match[0]) as Record<string, unknown>;
                const p = obj.posture;
                if (typeof p === "string" && (POSTURES as readonly string[]).includes(p)) {
                    posture = p as Posture;
                }
                if (typeof obj.bonus === "number") bonus = Math.round(obj.bonus);
                const rationale = typeof obj.rationale === "string" ? obj.rationale.trim() : "";
                if (rationale) this.coordLog.debug(`coordination rationale: ${rationale}`);
            } catch {
                this.coordLog.debug(`coordination: could not parse posture JSON — defaulting to NONE. text=${text}`);
            }
        } else {
            this.coordLog.debug(`coordination: no JSON found in response — defaulting to NONE. text=${text}`);
        }

        const result = await this.assignPosture(posture, { bonus });
        this.log.debug(`Coordination assignPosture(${posture}) → ${result}`);
    }
}
