import { PeerKind } from "../../models/message_injection.js";
import { StrategyRole } from "../../models/game_strategy.js";
import type { GameStrategy } from "../../models/game_strategy.js";
import type { Beliefs } from "../bdi/belief/beliefs.js";
import type { RuleStore } from "../bdi/desire/rule_store.js";
import type { InjectedIntention } from "../../models/intentions.js";
import type { Position } from "../../models/position.js";
import { manhattanDistance } from "../../utils/metrics.js";
import { evaluateHandshakeVote } from "../bdi/desire/scoring/vote.js";
import { carriedEffectiveValue } from "../bdi/desire/scoring/utils.js";
import { buildRendezvousHolds } from "./holds.js";
import { config } from "../../config.js";
import { createLogger, type Logger } from "../../utils/logger.js";

type HandshakePhase = "proposed" | "committed";

type HandshakeState = {
    rid: string;
    role: typeof StrategyRole.PickupAgent | typeof StrategyRole.DeliverAgent;
    partnerId: string;
    midpoint: Position;
    maxDistance: number;
    bonus: number;
    phase: HandshakePhase;
    startedAt: number;
};

/**
 * Single source of truth for the HANDOFF protocol.
 *
 * Owns:
 * - The `rid`-keyed handshake state (at most one active at a time per agent).
 * - Initiation logic: when a PICKUP_AGENT should propose (zone empty, carrying, cooldown).
 * - Vote logic: DELIVER evaluates and accepts/rejects; PICKUP validates and commits.
 * - Committed-state tick: PICKUP waits for DELIVER to arrive, then drops; DELIVER releases
 *   its hold once the parcels land on the ground.
 * - Abort/timeout: cleans up both sides if the handoff stalls.
 *
 * The `deliberate()` loop calls `tick()` every cycle.
 * The communication module calls `handleInbound()` for each handshake message.
 */
export class HandshakeManager {
    private active: HandshakeState | null = null;
    /** Set when a handshake settles (clear/abort) — the cooldown anchors here, not on send. */
    private lastSettledAt = 0;
    private readonly log: Logger;

    constructor(
        private readonly beliefs: Beliefs,
        private readonly ruleStore: RuleStore,
        private readonly sendMsg: (toId: string, tool: string, args: Record<string, unknown>) => Promise<void>,
        private readonly addInjectedIntention: (entry: InjectedIntention) => void,
        private readonly removeInjectedIntentions: (predicate: (e: InjectedIntention) => boolean) => void,
        private readonly getGameStrategy: () => GameStrategy | null,
        agentId?: string,
    ) {
        this.log = createLogger("coordination", agentId);
    }

    /**
     * Drive the handshake state machine. Call once per deliberation cycle.
     */
    tick(): void {
        const strategy = this.getGameStrategy();
        const now = Date.now();

        // If the strategy expired mid-handshake, abort cleanly.
        if (!strategy && this.active) {
            this.log.debug(`Handshake ${this.active.rid}: strategy expired — clearing`);
            this.clear();
            return;
        }

        if (this.active === null) {
            // Try to initiate if we're a PICKUP_AGENT with the right conditions.
            if (
                strategy?.role === StrategyRole.PickupAgent &&
                strategy.partnerId &&
                now - this.lastSettledAt >= config.handoff.proposeCooldownMs
            ) {
                this.tryInitiate(strategy, now);
            }
            return;
        }

        // Check timeout before anything else.
        // For a pending propose, use half the timeout (partner should reply quickly).
        const timeoutMs = this.active.phase === "proposed"
            ? config.handoff.completeTimeoutMs / 2
            : config.handoff.completeTimeoutMs;
        if (now - this.active.startedAt > timeoutMs) {
            this.log.debug(`Handshake ${this.active.rid} timed out (phase=${this.active.phase}) — aborting`);
            void this.sendMsg(this.active.partnerId, PeerKind.HandshakeAbort, { rid: this.active.rid });
            this.clear();
            return;
        }

        if (this.active.role === StrategyRole.PickupAgent && this.active.phase === "committed") {
            this.tickPickupCommitted();
        } else if (this.active.role === StrategyRole.DeliverAgent && this.active.phase === "committed") {
            this.tickDeliverCommitted();
        }
    }

    /**
     * Route an inbound handshake message to the appropriate handler.
     * Call from the communication layer on `handshake_propose`, `handshake_vote`, `handshake_abort`.
     */
    async handleInbound(senderId: string, tool: string, args: Record<string, unknown>): Promise<void> {
        switch (tool) {
            case PeerKind.HandshakePropose: return this.onPropose(senderId, args);
            case PeerKind.HandshakeVote:    return this.onVote(senderId, args);
            case PeerKind.HandshakeAbort:   this.onAbort(senderId, args); return;
        }
    }

    // ─── State-machine internals ──────────────────────────────────────────────

    private tryInitiate(strategy: GameStrategy, now: number): void {
        const me = this.beliefs.agents.getCurrentMe();
        if (!me) return;
        const carried = this.beliefs.parcels.getCarriedByAgent(me.id);
        if (carried.length === 0) return;

        // Only propose when the pickup zone has no more parcels to collect.
        const zoneCenter = strategy.pickupZoneCenter ?? strategy.tiles[0];
        if (zoneCenter) {
            const inZone = this.beliefs.parcels.getAvailableParcels().filter(p =>
                p.lastPosition !== null &&
                manhattanDistance(p.lastPosition, zoneCenter) <= strategy.maxDistance
            );
            if (inZone.length > 0) return;
        }

        const midpoint = strategy.tiles[0];
        if (!midpoint) return;

        const rid = `hs-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const args: Record<string, unknown> = {
            rid,
            midpoint_x: midpoint.x,
            midpoint_y: midpoint.y,
            max_distance: strategy.maxDistance,
            carried_value: carriedEffectiveValue(carried, this.ruleStore),
            carried_count: carried.length,
            bonus: strategy.bonus ?? 0,
        };

        this.active = {
            rid,
            role: StrategyRole.PickupAgent,
            partnerId: strategy.partnerId!,
            midpoint,
            maxDistance: strategy.maxDistance,
            bonus: strategy.bonus ?? 0,
            phase: "proposed",
            startedAt: now,
        };

        this.log.debug(`HandshakePropose ${rid} → ${strategy.partnerId} (carried=${carried.length})`);
        void this.sendMsg(strategy.partnerId!, PeerKind.HandshakePropose, args);
    }

    /**
     * PICKUP, committed: when both agents are in the midpoint zone, remove the hold and
     * inject a drop desire at the current position. When carrying drops to 0, handoff is done.
     */
    private tickPickupCommitted(): void {
        if (!this.active) return;
        const me = this.beliefs.agents.getCurrentMe();
        if (!me) return;

        const carried = this.beliefs.parcels.getCarriedByAgent(me.id);
        if (carried.length === 0) {
            this.log.debug(`Handshake ${this.active.rid}: PICKUP completed (carried=0)`);
            this.clear();
            return;
        }

        const myPos = this.beliefs.agents.getCurrentPosition();
        if (!myPos) return;

        // Find the partner's last known position from the friends list.
        const partnerPos = this.beliefs.agents.getCurrentFriends()
            .find(f => f.id === this.active!.partnerId)
            ?.lastPosition ?? null;

        const inZone = (p: Position) =>
            manhattanDistance(p, this.active!.midpoint) <= this.active!.maxDistance;

        if (inZone(myPos) && partnerPos && inZone(partnerPos)) {
            // Both in zone — remove the waiting hold and inject a drop at current position.
            // DELIVER_PARCEL at distance 0 → Infinity score → executor runs putdown next step.
            this.log.debug(`Handshake ${this.active.rid}: both in zone — triggering drop at (${myPos.x},${myPos.y})`);
            this.removeHandshakeHolds();
            this.addInjectedIntention({
                desire: {
                    type: "DELIVER_PARCEL",
                    target: { x: myPos.x, y: myPos.y },
                    bonus: config.handoff.dropReward,
                },
                expiresAt: Date.now() + 60_000,
                sourceId: "handshake",
            });
        }
    }

    /**
     * DELIVER, committed: once parcels appear in the midpoint zone (PICKUP dropped), release
     * the hold so autonomous REACH_PARCEL collects them.
     */
    private tickDeliverCommitted(): void {
        if (!this.active) return;

        const inZoneParcels = this.beliefs.parcels.getAvailableParcels().filter(p =>
            p.lastPosition !== null &&
            manhattanDistance(p.lastPosition, this.active!.midpoint) <= this.active!.maxDistance
        );

        if (inZoneParcels.length > 0) {
            this.log.debug(`Handshake ${this.active.rid}: parcels landed in zone — releasing DELIVER hold`);
            this.removeHandshakeHolds();
            this.clear();
            // Autonomous REACH_PARCEL will collect and deliver the grounded parcels.
        }
    }

    /** DELIVER side: evaluate and respond to a HandshakePropose. */
    private async onPropose(senderId: string, args: Record<string, unknown>): Promise<void> {
        const rid = typeof args.rid === "string" ? args.rid : "";

        // Reject if we're already committed to another handshake.
        if (this.active !== null) {
            this.log.debug(`HandshakePropose ${rid} from ${senderId} — rejected (active: ${this.active.rid})`);
            await this.sendMsg(senderId, PeerKind.HandshakeVote, { rid, accept: false });
            return;
        }

        const accept = evaluateHandshakeVote(this.beliefs, this.ruleStore, args);
        this.log.debug(`HandshakePropose ${rid} from ${senderId}: accept=${accept}`);

        if (!accept) {
            await this.sendMsg(senderId, PeerKind.HandshakeVote, { rid, accept: false });
            return;
        }

        // Parse midpoint coordinates.
        const midpoint_x    = typeof args.midpoint_x   === "number" ? args.midpoint_x   : null;
        const midpoint_y    = typeof args.midpoint_y   === "number" ? args.midpoint_y   : null;
        const max_distance  = typeof args.max_distance  === "number" ? args.max_distance  : null;
        const bonus         = typeof args.bonus         === "number" ? args.bonus         : 0;

        if (midpoint_x === null || midpoint_y === null || max_distance === null) {
            await this.sendMsg(senderId, PeerKind.HandshakeVote, { rid, accept: false });
            return;
        }

        const midpoint = { x: midpoint_x, y: midpoint_y };
        const now = Date.now();

        this.active = {
            rid, role: StrategyRole.DeliverAgent,
            partnerId: senderId, midpoint, maxDistance: max_distance, bonus,
            phase: "committed", startedAt: now,
        };

        // Inject a committed HOLD_TILE near the midpoint (tier 2, partner-keyed release).
        const from = this.beliefs.agents.getCurrentPosition();
        if (from) {
            const holds = buildRendezvousHolds(this.beliefs, from, midpoint, max_distance, config.handoff.holdReward, {
                releaseZone: { center: midpoint, maxDistance: max_distance },
                sourceId: "handshake",
                rendezvousId: rid,
            });
            for (const hold of holds) this.addInjectedIntention(hold);
        }

        await this.sendMsg(senderId, PeerKind.HandshakeVote, { rid, accept: true });
    }

    /** PICKUP side: receive the vote, validate against active state, and commit or clear. */
    private async onVote(senderId: string, args: Record<string, unknown>): Promise<void> {
        const rid    = typeof args.rid    === "string"  ? args.rid    : "";
        const accept = args.accept === true;

        // Validate: must match the pending proposed handshake exactly.
        if (
            !this.active ||
            this.active.phase !== "proposed" ||
            this.active.rid !== rid ||
            this.active.partnerId !== senderId
        ) {
            this.log.debug(`HandshakeVote from ${senderId} (rid=${rid}) — ignored (no matching proposed state)`);
            return;
        }

        if (!accept) {
            this.log.debug(`HandshakeVote ${rid}: rejected by ${senderId}`);
            this.clear();
            return;
        }

        this.log.debug(`HandshakeVote ${rid}: accepted by ${senderId} — committing`);
        this.active.phase = "committed";

        // Inject a committed HOLD_TILE near the midpoint so PICKUP navigates there and waits.
        const from = this.beliefs.agents.getCurrentPosition();
        if (from) {
            const holds = buildRendezvousHolds(this.beliefs, from, this.active.midpoint, this.active.maxDistance, config.handoff.holdReward, {
                releaseZone: { center: this.active.midpoint, maxDistance: this.active.maxDistance },
                sourceId: "handshake",
                rendezvousId: rid,
            });
            for (const hold of holds) this.addInjectedIntention(hold);
        }
    }

    /** Handle a HandshakeAbort from the partner. */
    private onAbort(senderId: string, args: Record<string, unknown>): void {
        const rid = typeof args.rid === "string" ? args.rid : "";
        if (!this.active || this.active.rid !== rid) {
            this.log.debug(`HandshakeAbort (rid=${rid}) from ${senderId} — no matching active handshake`);
            return;
        }
        this.log.debug(`HandshakeAbort ${rid} from ${senderId} — clearing`);
        this.clear();
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /** Remove all HOLD_TILE intentions that belong to this manager (tagged sourceId:"handshake"). */
    private removeHandshakeHolds(): void {
        this.removeInjectedIntentions(e =>
            e.sourceId === "handshake" && e.desire.type === "HOLD_TILE"
        );
    }

    /** Clear active state, remove any lingering holds, and reset the cooldown anchor. */
    private clear(): void {
        if (this.active) {
            this.removeHandshakeHolds();
            this.log.debug(`Handshake ${this.active.rid} cleared (role=${this.active.role} phase=${this.active.phase})`);
        }
        this.active = null;
        this.lastSettledAt = Date.now();
    }
}
