import { dispatch } from "./dispatch.js";
import type { Beliefs } from "../belief/beliefs.js";
import type { RuleStore } from "../belief/rule_store.js";
import type { InjectedIntention } from "../../../models/intentions.js";
import type { DesireType } from "../../../models/desires.js";
import { createLogger, type Logger } from "../../../utils/logger.js";

export class Messenger {
    private readonly log: Logger;

    constructor(private readonly socket: any, agentId?: string) {
        this.log = createLogger("messenger", agentId);
    }

    /**
     * Send a message to a specific agent.
     * @param toId ID of the target agent to send the message to
     * @param text The message content to send
     */
    async say(toId: string, text: string): Promise<void> {
        this.log.debug(`Say to ${toId}: "${text}"`);
        await this.socket.emitSay(toId, text);
    }

    /**
     * Broadcast a message to all agents.
     * @param text The message content to broadcast
     */
    async shout(text: string): Promise<void> {
        this.log.debug(`Shout to all: "${text}"`);
        await this.socket.emitShout(text);
    }

    /**
     * Send a direct question to a specific agent and await their response.
     * @param toId ID of the target agent to ask
     * @param text The question content to ask
     * @returns The response from the target agent
     */
    async ask(toId: string, text: string): Promise<string> {
        this.log.debug(`Ask to ${toId}: "${text}"`);
        return this.socket.emitAsk(toId, text);
    }

    /**
     * Subscribe to inbound peer messages.
     * @param beliefs Live belief state, used for the friend check and map guards.
     * @param ruleStore Rule store the agent may mutate on incoming rules.
     * @param addInjectedIntention Callback to push injected intentions into the intention queue.
     */
    async receive(
        beliefs: Beliefs,
        ruleStore: RuleStore,
        addInjectedIntention: (entry: InjectedIntention) => void,
        removeIntentionsByType: (type: DesireType["type"]) => void,
    ): Promise<void> {
        this.socket.on("msg", async (senderId: string, senderName: string, content: unknown) => {
            this.log.debug(`msg from ${senderName} (${senderId}): "${content}"`);
            if (!beliefs.agents.getCurrentFriends().some(f => f.id === senderId)) return;

            // Route the message content to the dispatcher, which will decode and handle it appropriately based on the tool name. The dispatcher may mutate beliefs, rules, and intentions as needed.
            await dispatch(content, senderId, senderName, beliefs, ruleStore, addInjectedIntention, removeIntentionsByType, this.log, (toId, text) => this.say(toId, text));
        });
    }
}
