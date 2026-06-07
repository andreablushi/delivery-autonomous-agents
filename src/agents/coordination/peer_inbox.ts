import { PeerKind, type PeerInjectionMessage, type BeliefsReport } from "../../models/message_injection.js";
import { createLogger, type Logger } from "../../utils/logger.js";

/** Stores the latest messages received from each peer, indexed by peer ID */
export class PeerInbox {
    // Stores the latest beliefs_report from each peer, along with the timestamp of when it was received
    private readonly reports = new Map<string, { report: BeliefsReport; at: number }>();
    // Stores the latest vote (rendezvous_vote, red_light_vote, goto_vote) from each peer, along with the timestamp of when it was received
    private readonly votes = new Map<string, { roundId: string; accept: boolean; at: number }>();
    private readonly log: Logger;

    constructor() {
        this.log = createLogger("coordination");
    }

    /** Decode and store a coordination message from a teammate */
    record(senderId: string, msg: PeerInjectionMessage): void {
        if (msg.tool === PeerKind.BeliefsReport) {
            this.log.debug(`Received beliefs_report from ${senderId}`);
            this.reports.set(senderId, { report: msg.args, at: Date.now() });
        }
        else if (
            msg.tool === PeerKind.RendezvousVote ||
            msg.tool === PeerKind.RedLightVote ||
            msg.tool === PeerKind.GotoVote
        ){
            const args = msg.args as Record<string, unknown>;
            if (typeof args.roundId === "string" && typeof args.accept === "boolean") {
                this.log.debug(`Received ${msg.tool} from ${senderId}: accept=${args.accept} roundId=${args.roundId}`);
                this.votes.set(senderId, { roundId: args.roundId, accept: args.accept, at: Date.now() });
            }
        }
    }

    /** Return only the belief reports that arrived at or after `since` (ms epoch). */
    freshReportsSince(since: number): Map<string, BeliefsReport> {
        const fresh = new Map<string, BeliefsReport>();
        for (const [id, { report, at }] of this.reports) {
            if (at >= since) fresh.set(id, report);
        }
        return fresh;
    }


    /**
     * Check if all the peers have accepted the proposal 
     * @param ids The peer IDs to check for acceptance
     * @param roundId The round ID of the proposal to check acceptance for
     * @param sentAt  The timestamp (ms epoch) of when the proposal was sent, 
     * to ensure we only consider votes that arrived after the proposal was sent
     * @returns true if all specified peers have accepted the proposal for the given round ID and sentAt timestamp, false otherwise
     */
    allAccepted(ids: string[], roundId: string, sentAt: number): boolean {
        return ids.every(id => {
            const vote = this.votes.get(id);
            return vote && vote.roundId === roundId && vote.accept && vote.at >= sentAt;
        });
    }
}
