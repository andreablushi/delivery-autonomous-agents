import { tryDecode, encode } from "../../../models/envelope.js";
import { applyInjection, type InjectionDeps } from "../../../models/apply_injection.js";
import type { Beliefs } from "../belief/beliefs.js";
import type { RuleStore } from "../belief/rule_store.js";
import type { InjectedIntention } from "../../../models/intentions.js";
import type { DesireType } from "../../../models/desires.js";
import type { Logger } from "../../../utils/logger.js";


/**
 * Decode `content` as a peer-injection envelope and route it to the
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
    // Try to decode the incoming message as a tool call envelope. If decoding fails, ignore the message.
    const envelope = tryDecode(content);
    if (!envelope) return;

    log.debug(`injection from ${senderName} (${senderId}): ${envelope.tool}`);

    // Request for the agent's current beliefs report. The agent responds by building a beliefs report and sending
    // it back to the requester as a peer injection message with the "beliefs_report" tool.
    if (envelope.tool === "request_beliefs") {
        if (!reply) { log.warn("request_beliefs received but no reply callback available"); return; }
        const report = beliefs.buildReport();
        const msg = encode({ v: 1, kind: "peer_injection", tool: "beliefs_report", args: report as unknown as Record<string, unknown> });
        await reply(senderId, msg);
        return;
    }

    // Beliefs reports are for the LLM coordinator only; BDI agents ignore them.
    if (envelope.tool === "beliefs_report") return;

    // All other peer-injectable tools are handled by the shared injection logic.
    const deps: InjectionDeps = {
        beliefs,
        ruleStore,
        addInjectedIntention,
        removeIntentionsByType,
        sourceId: senderId,
    };
    const result = applyInjection(envelope.tool, envelope.args, deps);
    if ("error" in result) log.warn(`injection error (${envelope.tool}):`, result.error);
}
