import type { Beliefs } from "../bdi/belief/beliefs.js";
import type { GameStrategy } from "../../models/game_strategy.js";
import { StrategyType, StrategyRole } from "../../models/game_strategy.js";
import { PeerKind, type PeerInjectionKind } from "../../models/message_injection.js";
import type { Logger } from "../../utils/logger.js";
import { config } from "../../config.js";

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
    private pendingVote: { rid: string; accept: boolean; at: number } | null = null;

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
    handleVote(senderId: string, rid: string, accept: boolean): void {
        this.pendingVote = { rid, accept, at: Date.now() };
        this.log.debug(`handpass_vote from ${senderId}: rid=${rid}, accept=${accept}`);
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

        // Compute meet tile = midpoint between agents, snapped to nearest reachable tile.
        const cx = Math.round((myPos.x + partnerPos.x) / 2);
        const cy = Math.round((myPos.y + partnerPos.y) / 2);
        const reachable = this.beliefs.map.allRendezvousTiles(myPos, cx, cy, config.coordination.opportunisticMeetRadius);
        if (reachable.length === 0) return;
        const meetTile = reachable[0]!;

        const bonus = this.armed!.bonus ?? 0;
        const carriedValue = carried.reduce((sum, p) => sum + p.reward, 0);
        const reward = Math.max(1, bonus + carriedValue);
        const ttlSeconds = 30;
        const rid = `hp-${now}-${partnerId.slice(-4)}`;

        this.lastInitiateAt = now;
        this.inFlight = true;
        this.pendingVote = null;

        try {
            this.log.debug(`Handpass propose ${rid} to ${partnerId} @ (${meetTile.x},${meetTile.y}), reward=${reward}`);
            await this.send(partnerId, PeerKind.HandpassPropose, {
                rid, meet_x: meetTile.x, meet_y: meetTile.y, reward, ttl_seconds: ttlSeconds,
            });

            await new Promise<void>(r => setTimeout(r, config.rendezvous.commitWindowMs));

            // Cast prevents TypeScript's control-flow narrowing from freezing the type at null
            // (set above) and ignoring the handleVote() update that occurred during the awaits.
            const vote = this.pendingVote as ({ rid: string; accept: boolean; at: number } | null);
            const accepted = vote !== null && vote.rid === rid && vote.accept && vote.at >= now;

            if (accepted) {
                this.log.debug(`Handpass ${rid}: partner accepted — committing (PASSER)`);
                await this.send(partnerId, PeerKind.HandpassCommit, {
                    rid, meet_x: meetTile.x, meet_y: meetTile.y, reward, ttl_seconds: ttlSeconds,
                });
                this.setGameStrategy({
                    strategy: StrategyType.Opportunistic,
                    role: StrategyRole.Passer,
                    tiles: [meetTile],
                    maxDistance: config.handoff.zoneRadius,
                    partnerId,
                    expiresAt: now + ttlSeconds * 1_000,
                });
                // One-shot: disarm so we don't re-initiate next pickup.
                this.armed = null;
            } else {
                this.log.debug(`Handpass ${rid}: partner rejected or timed out — staying armed`);
                await this.send(partnerId, PeerKind.HandpassAbort, { rid });
            }
        } finally {
            this.inFlight = false;
        }
    }
}
