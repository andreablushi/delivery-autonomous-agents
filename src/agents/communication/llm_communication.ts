import { Communication } from "./communication.js";
import type { PeerInjectionMessage } from "../../models/message_injection.js";
import type { Beliefs } from "../bdi/belief/beliefs.js";

/**
 * Extends Communication with the two capabilities exclusive to the LLM agent:
 * - Coordination messages (beliefs_report, rendezvous_vote, red_light_vote) are
 *   forwarded to the Coordinator via onCoordination().
 * - Raw chat from the mission emitter is forwarded to LLMClient via onMission().
 */
export class LLMCommunication extends Communication {
    private coordinationHook: ((senderId: string, msg: PeerInjectionMessage) => void) | null = null;
    private missionHook: ((senderId: string, senderName: string, content: string) => void) | null = null;

    constructor(socket: any, beliefs: Beliefs, agentId?: string) {
        super(socket, beliefs, agentId);
    }

    /** Set the callback for handling coordination messages. */
    onCoordination(fn: (senderId: string, msg: PeerInjectionMessage) => void): void {
        this.coordinationHook = fn;
    }

    /** Set the callback for handling mission chat messages. */
    onMission(fn: (senderId: string, senderName: string, content: string) => void): void {
        this.missionHook = fn;
    }

    protected override handleCoordinationMessage(senderId: string, msg: PeerInjectionMessage): void {
        this.coordinationHook?.(senderId, msg);
    }

    protected override handleRawMessage(senderId: string, senderName: string, content: string): void {
        this.missionHook?.(senderId, senderName, content);
    }
}
