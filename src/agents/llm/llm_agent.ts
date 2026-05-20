import { BDIAgent } from "../bdi/bdi_agent.js";
import { LLMClient } from "./client/llm_client.js";
import { createLogger, type Logger } from "../../utils/logger.js";

export class LLMAgent {
    private readonly bdi: BDIAgent;
    private readonly client: LLMClient;
    private readonly log: Logger;

    constructor(socket: any, agentId?: string) {
    this.log = createLogger("llm", agentId);
    this.bdi = new BDIAgent(socket, agentId);
    this.client = new LLMClient(
        entry => this.bdi.addPersistentDesire(entry),
        this.bdi.getMessenger(),
        agentId
    );

    socket.on("msg", (senderId: string, senderName: string, content: unknown) => {
        if (!this.isValidMessage(senderId, senderName, content)) return;

        this.log.debug(`msg from ${senderName} (${senderId}): "${content}"`);
        
        this.client
            .processMessage(senderId, senderName, content as string, this.bdi.getBeliefs())
            .catch((err: unknown) => this.log.error("LLM call failed:", err));
    });
}

/**
 * Check if the incoming message is valid and should be processed by the LLM.
 * This is a simple filter to ignore irrelevant messages and reduce unnecessary LLM calls.
 * @param senderId ID of the message sender (e.g. "ADMIN" or "agent-1")
 * @param senderName Name of the message sender (e.g. "ADMIN" or "agent-1")
 * @param content The message content, expected to be a non-empty string
 * @returns true if the message is valid and should be processed, false otherwise
 */
private isValidMessage(senderId: string, senderName: string, content: unknown): content is string {
    if (typeof content !== "string" || content.trim() === "") return false;

    // If MISSION_EMITTER_NAME or MISSION_EMITTER_ID are set, only process messages from that sender. Otherwise, process all messages.
    const expectedName = process.env.MISSION_EMITTER_NAME;
    const expectedId   = process.env.MISSION_EMITTER_ID;

    return senderName === expectedName || senderId === expectedId;
}
}
