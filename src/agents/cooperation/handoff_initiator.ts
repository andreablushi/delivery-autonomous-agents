import type { Beliefs } from "../bdi/belief/beliefs.js";
import type { GameStrategy } from "../../models/game_strategy.js";
import { StrategyType, StrategyRole } from "../../models/game_strategy.js";
import type { Logger } from "../../utils/logger.js";
import { config } from "../../config.js";
import { computeHandoffGeometry } from "./handoff_geometry.js";
import type { Negotiator } from "../coordination/negotiator.js";

/**
 * Owned by every BDIAgent. When armed (by the coordinator), fires a handoff handshake
 * after any successful pickup. The first agent to pick up becomes PASSER; its partner,
 * once it accepts, becomes RECEIVER. One-shot: disarms itself on commit.
 *
 * The 2PC (propose → vote → commit/abort) is delegated to the shared Negotiator so
 * the handoff and coordinator protocols share a single implementation and PeerInbox.
 */
export class HandoffInitiator {
    private armed: { bonus?: number; expiresAt: number } | null = null;
    private lastInitiateAt = 0;
    private inFlight = false;

    constructor(
        private readonly beliefs: Beliefs,
        private readonly negotiator: Negotiator,
        private readonly setGameStrategy: (strategy: GameStrategy) => void,
        private readonly log: Logger,
    ) {}

    arm(bonus?: number, ttlMs = 120_000): void {
        this.armed = { bonus, expiresAt: Date.now() + ttlMs };
        this.log.debug(`HandoffInitiator armed, bonus=${bonus ?? 0}, ttlMs=${ttlMs}`);
    }

    disarm(): void {
        this.armed = null;
        this.log.debug("HandoffInitiator disarmed");
    }

    isArmed(): boolean {
        if (!this.armed) return false;
        if (Date.now() > this.armed.expiresAt) {
            this.armed = null;
            return false;
        }
        return true;
    }

    /**
     * Called after every successful pickup. Guards: armed, cooldown, exactly one teammate,
     * carrying ≥1 parcel, partner position known, no handshake in flight.
     * On commit: sets self as PASSER and disarms (one-shot). Partner becomes RECEIVER via
     * the HandoffCommit apply_injection case.
     * On failure/timeout: the Negotiator sends abort; stays armed for the next pickup.
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

        this.lastInitiateAt = now;
        this.inFlight = true;

        try {
            this.log.debug(`Handoff propose to ${partnerId} @ (${geo.meetTile.x},${geo.meetTile.y}), reward=${reward}`);
            await this.negotiator.proposeHandoff(
                partnerId,
                { meet_x: geo.meetTile.x, meet_y: geo.meetTile.y, reward, ttl_seconds: ttlSeconds },
                { approach_x: geo.receiverApproach.x, approach_y: geo.receiverApproach.y },
                () => {
                    this.setGameStrategy({
                        strategy: StrategyType.Opportunistic,
                        role: StrategyRole.Passer,
                        meetTile: geo.meetTile,
                        approachTile: geo.carrierApproach,
                        maxDistance: config.handoff.zoneRadius,
                        partnerId,
                        expiresAt: now + ttlSeconds * 1_000,
                    });
                    // One-shot: disarm so we don't re-initiate on the next pickup.
                    this.armed = null;
                },
            );
        } finally {
            this.inFlight = false;
        }
    }
}
