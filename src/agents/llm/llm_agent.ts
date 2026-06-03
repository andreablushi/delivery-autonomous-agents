import { BDIAgent } from "../bdi/bdi_agent.js";
import { LLMClient } from "./client/llm_client.js";
import { Coordinator } from "./coordination/coordinator.js";
import { createLogger, type Logger } from "../../utils/logger.js";

export class LLMAgent {
    private readonly bdi: BDIAgent;
    private readonly client: LLMClient;
    // coordinator is assigned immediately after client in the constructor; the lazy closure
    // `rawArgs => this.coordinator.proposeRendezvous(rawArgs)` passed to client is only
    // invoked at tool-call time, well after construction completes.
    private coordinator!: Coordinator;
    private readonly log: Logger;

    constructor(socket: any, agentId?: string) {
        this.log = createLogger("llm", agentId);
        this.bdi = new BDIAgent(socket, agentId);
        this.client = new LLMClient(
            entry => this.bdi.addInjectedIntention(entry),
            type => this.bdi.removeIntentionsByType(type),
            this.bdi.getMessenger(),
            this.bdi.getRuleStore(),
            rawArgs => this.coordinator.proposeRendezvous(rawArgs),
            agentId
        );
        this.coordinator = new Coordinator(
            this.bdi.getBeliefs(),
            this.bdi.getMessenger(),
            this.client,
            entry => this.bdi.addInjectedIntention(entry),
        );
        this.coordinator.start();

        // Listen for incoming messages.
        // Always route to the coordinator first so beliefs_report messages are captured
        // regardless of the MISSION_EMITTER filter that gates LLM processing.
        socket.on("msg", (senderId: string, senderName: string, content: unknown) => {
            this.coordinator.handleInbound(senderId, content);

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
