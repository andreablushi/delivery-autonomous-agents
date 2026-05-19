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
        this.client = new LLMClient(entry => this.bdi.addPersistentDesire(entry), this.bdi.getMessenger(), agentId);

        socket.on("msg", (senderId: string, senderName: string, content: unknown) => {
            // Remove all the messages that are not strings or are empty
            if (typeof content !== "string" || content.trim() === "") return;
            this.log.debug(`msg from ${senderName} (${senderId}): "${content}"`);
            //TODO: filter out noisy messages from other users
            this.client
                .processMessage(senderId, senderName, content, this.bdi.getBeliefs())
                .catch((err: unknown) => this.log.error("LLM call failed:", err));
        });
    }
}
