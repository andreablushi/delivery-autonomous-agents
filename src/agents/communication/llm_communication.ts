import { Communication } from "./communication.js";
import type { Beliefs } from "../bdi/belief/beliefs.js";

/**
 * Extends Communication with the capability exclusive to the LLM agent:
 * raw chat from the mission emitter is forwarded to LLMClient via onMission().
 * Vote and belief-report routing is handled in the base class via PeerInbox.
 */
export class LLMCommunication extends Communication {
    private missionHook: ((senderId: string, senderName: string, content: string) => void) | null = null;

    constructor(socket: any, beliefs: Beliefs, agentId?: string) {
        super(socket, beliefs, agentId);
    }

    /** Set the callback for handling mission chat messages. */
    onMission(fn: (senderId: string, senderName: string, content: string) => void): void {
        this.missionHook = fn;
    }

    protected override handleRawMessage(senderId: string, senderName: string, content: string): void {
        this.missionHook?.(senderId, senderName, content);
    }
}
