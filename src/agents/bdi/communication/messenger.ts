import { createLogger, type Logger } from "../../../utils/logger.js";

export class Messenger {
    private readonly log: Logger;

    constructor(private readonly socket: any, agentId?: string) {
        this.log = createLogger("comm", agentId);
    }

    async say(toId: string, text: string): Promise<void> {
        this.log.debug(`say → ${toId}: "${text}"`);
        await this.socket.emitSay(toId, text);
    }

    async shout(text: string): Promise<void> {
        this.log.debug(`shout: "${text}"`);
        await this.socket.emitShout(text);
    }

    async ask(toId: string, text: string): Promise<string> {
        this.log.debug(`ask → ${toId}: "${text}"`);
        return this.socket.emitAsk(toId, text);
    }
}
