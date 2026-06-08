import type { Beliefs } from "../bdi/belief/beliefs.js";
import type { GameStrategy } from "../../models/game_strategy.js";
import { StrategyType, StrategyRole } from "../../models/game_strategy.js";
import { PeerKind, type PeerInjectionKind } from "../../models/message_injection.js";
import type { Logger } from "../../utils/logger.js";
import { config } from "../../config.js";
import { computeHandoffGeometry } from "./handoff_geometry.js";

/**
 * Owned by every BDIAgent. When armed (by the coordinator), fires a handpass handshake
 * after any successful pickup. The first agent to pick up becomes PASSER; its partner,
 * once it accepts, becomes RECEIVER. One-shot: disarms itself on commit.
 */
export class HandpassInitiator {
    private armed: { bonus?: number; expiresAt: number } | null = null;
    private lastInitiateAt = 0;
    private inFlight = false;
    /** Latest vote received from the partner. Set by handleVote(), consumed by maybeInitiate(). */
    private pendingVote: { roundId: string; accept: boolean; at: number } | null = null;

    constructor(
        private readonly beliefs: Beliefs,
        private readonly send: (toId: string, tool: Exclude<PeerInjectionKind, "beliefs_report">, args: Record<string, unknown>) => Promise<void>,
        private readonly setGameStrategy: (strategy: GameStrategy) => void,
        private readonly log: Logger,
    ) {}

    arm(bonus?: number, ttlMs = 120_000): void {
        this.armed = { bonus, expiresAt: Date.now() + ttlMs };
        this.log.debug(`HandpassInitiator armed, bonus=${bonus ?? 0}, ttlMs=${ttlMs}`);
    }

    disarm(): void {
        this.armed = null;
        this.log.debug("HandpassInitiator disarmed");
    }

    isArmed(): boolean {
        if (!this.armed) return false;
        if (Date.now() > this.armed.expiresAt) {
            this.armed = null;
            return false;
        }
        return true;
    }

    /** Called by the Communication router when a handpass_vote arrives from a peer. */
    handleVote(senderId: string, roundId: string, accept: boolean): void {
        this.pendingVote = { roundId, accept, at: Date.now() };
        this.log.debug(`handpass_vote from ${senderId}: roundId=${roundId}, accept=${accept}`);
    }

    /**
     * Called after every successful pickup. Guards: armed, cooldown, exactly one teammate,
     * carrying ≥1 parcel, partner position known, no handshake in flight.
     * On success: sets self as PASSER, sends commit to the partner (who becomes RECEIVER).
     * On failure/timeout: sends abort, stays armed for the next pickup.
     */
    async maybeInitiate(): Promise<void> {
        if (!this.isArmed()) return;
        if (this.inFlight) return;
        const now = Date.now();
        if (now - this.lastInitiateAt < config.coordination.opportunisticCooldownMs) return;

        const teammates = this.beliefs.agents.getTeammateIds();
        if (teammates.size !== 1) return;
        const partnerId = [...teammates][0]!;

        const me = this.beliefs.agents.getCurrentMe();
        if (!me) return;
        const myPos = this.beliefs.agents.getCurrentPosition();
        if (!myPos) return;

        const carried = this.beliefs.parcels.getCarriedByAgent(me.id);
        if (carried.length === 0) return;

        const partnerPos = this.beliefs.agents.getCurrentFriends().find(f => f.id === partnerId)?.lastPosition ?? null;
        if (!partnerPos) return;

        // Compute the exchange tile M and distinct adjacent approach cells for both agents.
        const cx = Math.round((myPos.x + partnerPos.x) / 2);
        const cy = Math.round((myPos.y + partnerPos.y) / 2);
        const geo = computeHandoffGeometry(
            this.beliefs, myPos, partnerPos,
            { x: cx, y: cy }, config.coordination.opportunisticMeetRadius,
        );
        if (!geo) return; // no valid geometry — skip this handshake attempt

        const bonus = this.armed!.bonus ?? 0;
        const carriedValue = carried.reduce((sum, p) => sum + p.reward, 0);
        const reward = Math.max(1, bonus + carriedValue);
        const ttlSeconds = 30;
        const roundId = `hp-${now}-${partnerId.slice(-4)}`;

        this.lastInitiateAt = now;
        this.inFlight = true;
        // pendingVote is NOT cleared here: roundId + timestamp checks below are sufficient
        // to reject any vote from a previous round.

        try {
            this.log.debug(`Handpass propose ${roundId} to ${partnerId} @ (${geo.meetTile.x},${geo.meetTile.y}), reward=${reward}`);
            await this.send(partnerId, PeerKind.HandpassPropose, {
                roundId, meet_x: geo.meetTile.x, meet_y: geo.meetTile.y, reward, ttl_seconds: ttlSeconds,
            });

            await new Promise<void>(r => setTimeout(r, config.rendezvous.commitWindowMs));

            const vote = this.pendingVote;
            const accepted = vote !== null && vote.roundId === roundId && vote.accept && vote.at >= now;

            if (accepted) {
                this.log.debug(`Handpass ${roundId}: partner accepted — committing (PASSER)`);
                await this.send(partnerId, PeerKind.HandpassCommit, {
                    roundId,
                    meet_x: geo.meetTile.x, meet_y: geo.meetTile.y,
                    reward, ttl_seconds: ttlSeconds,
                    approach_x: geo.receiverApproach.x, approach_y: geo.receiverApproach.y,
                });
                this.setGameStrategy({
                    strategy: StrategyType.Opportunistic,
                    role: StrategyRole.Passer,
                    meetTile: geo.meetTile,
                    approachTile: geo.carrierApproach,
                    maxDistance: config.handoff.zoneRadius,
                    partnerId,
                    expiresAt: now + ttlSeconds * 1_000,
                });
                // One-shot: disarm so we don't re-initiate next pickup.
                this.armed = null;
            } else {
                this.log.debug(`Handpass ${roundId}: partner rejected or timed out — staying armed`);
                await this.send(partnerId, PeerKind.HandpassAbort, { roundId });
            }
        } finally {
            this.inFlight = false;
        }
    }
}
