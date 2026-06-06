import { BDIAgent } from "../bdi/bdi_agent.js";
import { LLMCommunication } from "../communication/llm_communication.js";
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
    /** Latest mission directive from the filtered emitter; forwarded to each coordination prompt. */
    private missionNote = "";

    constructor(socket: any, agentId?: string, teammateIds?: string[]) {
        this.log = createLogger("llm", agentId);
        let comm!: LLMCommunication;
        this.bdi = new BDIAgent(socket, agentId, teammateIds,
            (s, b, id) => { comm = new LLMCommunication(s, b, id); return comm; },
            // Lazy closure: coordinator is assigned after bdi in this constructor and is available by the time any pickup fires.
            () => { void this.coordinator.maybeProposeOpportunisticHandoff(); });
        this.client = new LLMClient(
            entry => this.bdi.addInjectedIntention(entry),
            type => this.bdi.removeIntentionsByType(type),
            strategy => this.bdi.setGameStrategy(strategy),
            () => this.bdi.getGameStrategy(),
            comm,
            this.bdi.getRuleStore(),
            rawArgs => this.coordinator.proposeRendezvous(rawArgs),
            rawArgs => this.coordinator.proposeRedLight(rawArgs),
            (agentId2, rawArgs) => this.coordinator.proposeGoto(agentId2, rawArgs),
            (posture, opts) => this.coordinator.assignPosture(posture, opts ?? {}),
            agentId
        );
        this.coordinator = new Coordinator(
            this.bdi.getBeliefs(),
            comm,
            this.client,
            entry => this.bdi.addInjectedIntention(entry),
            strategy => this.bdi.setGameStrategy(strategy),
            () => this.missionNote,
        );
        this.coordinator.start();

        // Handler for coordination messages from teammates. Forwarded to the coordinator for processing.
        comm.onCoordination((senderId, msg) => this.coordinator.handleInbound(senderId, msg));

        // Handler for mission chat messages from the mission emitter. Passed to the LLM client
        comm.onMission((senderId, senderName, content) => {
            if (!this.isValidMessage(senderId, senderName, content)) return;
            this.missionNote = content;
            this.log.debug(`mission msg from ${senderName} (${senderId}): "${content}"`);
            this.client
                .processMessage(senderId, senderName, content, this.bdi.getBeliefs())
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
    private isValidMessage(senderId: string, senderName: string, content: string): boolean {
        if (content.trim() === "") return false;

        // If MISSION_EMITTER_NAME or MISSION_EMITTER_ID are set, only process messages from that sender. Otherwise, process all messages.
        const expectedName = process.env.MISSION_EMITTER_NAME;
        const expectedId   = process.env.MISSION_EMITTER_ID;

        return senderName === expectedName || senderId === expectedId;
    }
}
