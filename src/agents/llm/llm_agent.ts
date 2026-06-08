import { BDIAgent } from "../bdi/bdi_agent.js";
import { LLMCommunication } from "../communication/llm_communication.js";
import { LLMClient } from "./client/llm_client.js";
import { CooperationLoop } from "./cooperation/cooperation_loop.js";
import { TeamStrategyAssigner } from "../cooperation/strategy/strategy_assigner.js";
import { PerformanceTracker } from "../cooperation/strategy/performance_tracker.js";
import { createLogger, type Logger } from "../../utils/logger.js";

export class LLMAgent {
    private readonly bdi: BDIAgent;
    private readonly client: LLMClient;
    private readonly loop: CooperationLoop;
    private readonly log: Logger;
    /** Latest mission directive from the filtered emitter; forwarded to each cooperation prompt. */
    private missionNote = "";

    constructor(socket: any, agentId?: string, teammateIds?: string[]) {
        this.log = createLogger("llm", agentId);
        let comm!: LLMCommunication;
        this.bdi = new BDIAgent(socket, agentId, teammateIds,
            (s, b, id) => { comm = new LLMCommunication(s, b, id); return comm; });

        const beliefs = this.bdi.getBeliefs();
        const peerInbox = this.bdi.getPeerInbox();
        const negotiator = this.bdi.getNegotiator();

        const strategyAssigner = new TeamStrategyAssigner(
            beliefs,
            comm,
            entry => this.bdi.addInjectedDesire(entry),
            strategy => this.bdi.setGameStrategy(strategy),
            (bonus, ttlMs) => this.bdi.armHandoff(bonus, ttlMs),
            () => this.bdi.disarmHandoff(),
        );
        const performanceTracker = new PerformanceTracker();

        this.client = new LLMClient(
            entry => this.bdi.addInjectedDesire(entry),
            type => this.bdi.removeInjectedDesiresByType(type),
            strategy => this.bdi.setGameStrategy(strategy),
            () => this.bdi.getGameStrategy(),
            comm,
            this.bdi.getRuleStore(),
            rawArgs => negotiator.proposeRendezvous(rawArgs),
            rawArgs => negotiator.proposeRedLight(rawArgs),
            (agentId2, rawArgs) => negotiator.proposeGoto(agentId2, rawArgs),
            agentId
        );

        this.loop = new CooperationLoop(
            beliefs,
            comm,
            this.client,
            peerInbox,
            strategyAssigner,
            performanceTracker,
            () => this.missionNote,
        );
        this.loop.start();

        // Handler for mission chat messages from the mission emitter. Passed to the LLM client.
        // Also triggers an immediate cooperation round so strategy changes take effect right away.
        comm.onMission((senderId, senderName, content) => {
            if (!this.isValidMessage(senderId, senderName, content)) return;
            this.missionNote = content;
            void this.loop.runRound({ force: true });
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
