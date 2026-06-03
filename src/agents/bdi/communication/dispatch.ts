import { tryDecode, encode } from "../../../models/message_injection.js";
import { applyInjection, type InjectionDeps } from "../../../models/apply_injection.js";
import type { Beliefs } from "../belief/beliefs.js";
import type { RuleStore } from "../belief/rule_store.js";
import type { InjectedIntention } from "../../../models/intentions.js";
import type { DesireType } from "../../../models/desires.js";
import type { Logger } from "../../../utils/logger.js";
import { evaluateRendezvousVote } from "../desire/scoring/vote.js";


/**
 * Decode `content` as a peer-injection message and route it to the
 * appropriate handler.
 * @param content   Raw message payload received from the socket.
 * @param senderId  Socket ID of the sender (already verified as a friend).
 * @param senderName Display name of the sender, used for debug logging.
 * @param beliefs   Live belief state of the receiving agent.
 * @param ruleStore Rule store the receiving agent mutates.
 * @param addInjectedIntention Callback to push a new injected intention.
 * @param removeIntentionsByType Callback to remove intentions by desire type.
 * @param log       Logger scoped to the calling Messenger.
 * @param reply     Optional callback to send a message back to the sender.
 */
export async function dispatch(
    content: unknown,
    senderId: string,
    senderName: string,
    beliefs: Beliefs,
    ruleStore: RuleStore,
    addInjectedIntention: (entry: InjectedIntention) => void,
    removeIntentionsByType: (type: DesireType["type"]) => void,
    log: Logger,
    reply?: (toId: string, text: string) => Promise<void>,
): Promise<void> {
    // Try to decode the incoming message as a tool call message. If decoding fails, ignore the message.
    const message = tryDecode(content);
    if (!message) return;

    log.debug(`injection from ${senderName} (${senderId}): ${message.tool}`);

    // Request for the agent's current beliefs report. The agent responds by building a beliefs report and sending
    // it back to the requester as a peer injection message with the "beliefs_report" tool.
    if (message.tool === "request_beliefs") {
        if (!reply) { log.warn("request_beliefs received but no reply callback available"); return; }
        const report = beliefs.buildReport();
        const msg = encode({ v: 1, kind: "peer_injection", tool: "beliefs_report", args: report });
        await reply(senderId, msg);
        return;
    }

    // Beliefs reports are for the LLM coordinator only; BDI agents ignore them.
    if (message.tool === "beliefs_report") return;

    // Rendezvous proposal: evaluate value-aware vote and reply immediately.
    if (message.tool === "rendezvous_propose") {
        if (!reply) { log.warn("rendezvous_propose received but no reply callback available"); return; }
        const accept = evaluateRendezvousVote(beliefs, ruleStore, message.args);
        const rid = typeof (message.args as Record<string, unknown>).rid === "string"
            ? (message.args as Record<string, unknown>).rid as string
            : "";
        log.debug(`rendezvous_propose from ${senderName}: accept=${accept} (rid=${rid})`);
        const voteMsg = encode({ v: 1, kind: "peer_injection", tool: "rendezvous_vote", args: { rid, accept } });
        await reply(senderId, voteMsg);
        return;
    }

    // Rendezvous votes are consumed by the LLM coordinator only; BDI agents ignore them.
    if (message.tool === "rendezvous_vote") return;

    // All other peer-injectable tools are handled by the shared injection logic.
    const deps: InjectionDeps = {
        beliefs,
        ruleStore,
        addInjectedIntention,
        removeIntentionsByType,
        sourceId: senderId,
    };
    const result = applyInjection(message.tool, message.args, deps);
    if ("error" in result) log.warn(`injection error (${message.tool}):`, result.error);
}
