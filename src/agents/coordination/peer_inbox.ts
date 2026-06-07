import { PeerKind, type PeerInjectionMessage, type BeliefsReport } from "../../models/message_injection.js";
import { createLogger, type Logger } from "../../utils/logger.js";

/**
 * Stores inbound peer messages (beliefs_report and proposal votes) for use by the
 * cooperation loop and the negotiator.
 *
 * Responsibilities:
 *   - record(): decode and store a coordination message from a teammate
 *   - freshReportsSince(ts): return belief reports that arrived after a given timestamp
 *   - allAccepted(ids, roundId, sentAt): predicate for two-phase commit quorum check
 */
export class PeerInbox {
    private readonly reports = new Map<string, { report: BeliefsReport; at: number }>();
    private readonly votes = new Map<string, { roundId: string; accept: boolean; at: number }>();
    private readonly log: Logger;

    constructor() {
        this.log = createLogger("coordination");
    }

    /** Decode and store a coordination message from a teammate. */
    record(senderId: string, msg: PeerInjectionMessage): void {
        if (msg.tool === PeerKind.BeliefsReport) {
            this.log.debug(`Received beliefs_report from ${senderId}`);
            this.reports.set(senderId, { report: msg.args, at: Date.now() });
        } else if (
            msg.tool === PeerKind.RendezvousVote ||
            msg.tool === PeerKind.RedLightVote ||
            msg.tool === PeerKind.GotoVote
        ) {
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
     * Return true when every peer in `ids` has cast an accepted vote for `roundId`
     * that arrived at or after `sentAt` (ms epoch).
     */
    allAccepted(ids: string[], roundId: string, sentAt: number): boolean {
        return ids.every(id => {
            const vote = this.votes.get(id);
            return vote && vote.roundId === roundId && vote.accept && vote.at >= sentAt;
        });
    }
}
