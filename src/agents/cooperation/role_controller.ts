import type { Beliefs } from "../bdi/belief/beliefs.js";
import type { GameStrategy } from "../../models/game_strategy.js";
import type { GeneratedDesires, ReachTileDesire } from "../../models/desires.js";
import { StrategyRole } from "../../models/game_strategy.js";
import { manhattanDistance } from "../../utils/metrics.js";
import { generateReachParcelDesires, generateDeliverDesires } from "../bdi/desire/desire_generator.js";
import { config } from "../../config.js";
import { createLogger, type Logger } from "../../utils/logger.js";

type PickupState = "COLLECT" | "TO_MIDPOINT" | "DROP";
type DeliverState = "WAIT" | "COLLECT_DROP" | "DELIVERING" | "RETURN";

/**
 * Deterministic per-role state machine for the HANDOFF cooperation strategy.
 *
 * Each role has an explicit state that gates which desires are generated this cycle.
 * Because the state decides the desire type, a stray parcel physically cannot preempt
 * the role — the competing desire is never placed in the queue.
 *
 * PICKUP flow:  COLLECT → TO_MIDPOINT → DROP → COLLECT …
 * DELIVER flow: WAIT → COLLECT_DROP → DELIVERING → RETURN → WAIT …
 *
 * The state machine advances purely from beliefs (own position, partner beacon, parcels).
 * No peer messages are required.
 */
export class RoleController {
    private pickupState: PickupState = "COLLECT";
    private deliverState: DeliverState = "WAIT";
    private lastRole: string | null = null;
    private lastPartnerId: string | undefined = undefined;
    private readonly log: Logger;

    constructor(agentId?: string) {
        this.log = createLogger("coordination", agentId);
    }

    /**
     * Reset the FSM to its initial state.
     * Called when the active strategy is cleared or expires.
     */
    reset(): void {
        this.pickupState = "COLLECT";
        this.deliverState = "WAIT";
        this.lastRole = null;
        this.lastPartnerId = undefined;
    }

    /**
     * Sync the FSM to the current strategy. Resets if the role or partner changed
     * (e.g. a new strategy was assigned while one was already active).
     */
    sync(strategy: GameStrategy): void {
        const changed = strategy.role !== this.lastRole || strategy.partnerId !== this.lastPartnerId;
        if (changed) {
            this.pickupState = "COLLECT";
            this.deliverState = "WAIT";
            this.lastRole = strategy.role;
            this.lastPartnerId = strategy.partnerId;
            this.log.debug(`RoleController synced → role=${strategy.role}`);
        }
    }

    /**
     * Advance the FSM based on current beliefs.
     * Called once per deliberation cycle (and again after a pickup, via executor callback).
     */
    tick(beliefs: Beliefs, strategy: GameStrategy): void {
        if (strategy.role === StrategyRole.PickupAgent) {
            this.tickPickup(beliefs, strategy);
        } else if (strategy.role === StrategyRole.DeliverAgent) {
            this.tickDeliver(beliefs, strategy);
        }
    }

    /**
     * Build the gated set of desires for the current FSM state.
     * Only the desires appropriate to the current state are emitted — no other
     * desire types appear in the returned map.
     */
    buildDesires(beliefs: Beliefs, strategy: GameStrategy): GeneratedDesires {
        const desires: GeneratedDesires = new Map();
        if (strategy.role === StrategyRole.PickupAgent) {
            this.buildPickupDesires(desires, beliefs, strategy);
        } else if (strategy.role === StrategyRole.DeliverAgent) {
            this.buildDeliverDesires(desires, beliefs, strategy);
        }
        return desires;
    }

    // ─── PICKUP state machine ─────────────────────────────────────────────────

    private tickPickup(beliefs: Beliefs, strategy: GameStrategy): void {
        const me = beliefs.agents.getCurrentMe();
        if (!me) return;
        const myPos = beliefs.agents.getCurrentPosition();
        if (!myPos) return;
        const midpoint = strategy.tiles[0];
        if (!midpoint) return;

        const carried = beliefs.parcels.getCarriedByAgent(me.id);
        const inMeetZone = (p: { x: number; y: number }) =>
            manhattanDistance(p, midpoint) <= strategy.maxDistance;

        switch (this.pickupState) {
            case "COLLECT": {
                const carryCapacity = beliefs.agents.getCarryCapacity() ?? Infinity;
                const pickupZone = strategy.pickupZoneCenter ?? midpoint;
                const inAreaParcels = beliefs.parcels.getAvailableParcels().filter(p =>
                    p.lastPosition !== null &&
                    manhattanDistance(p.lastPosition, pickupZone) <= config.handoff.pickupRadius
                );
                if (carried.length >= carryCapacity) {
                    this.pickupState = "TO_MIDPOINT";
                    this.log.debug(`PICKUP: COLLECT → TO_MIDPOINT (at carry capacity)`);
                } else if (carried.length > 0 && inAreaParcels.length === 0) {
                    this.pickupState = "TO_MIDPOINT";
                    this.log.debug(`PICKUP: COLLECT → TO_MIDPOINT (carrying=${carried.length}, area empty)`);
                }
                break;
            }
            case "TO_MIDPOINT": {
                if (carried.length === 0) {
                    // Partner took the parcels already (or we never had any) — go back to collect.
                    this.pickupState = "COLLECT";
                    this.log.debug(`PICKUP: TO_MIDPOINT → COLLECT (not carrying)`);
                    break;
                }
                const partnerPos = beliefs.agents.getCurrentFriends()
                    .find(f => f.id === strategy.partnerId)?.lastPosition ?? null;
                if (inMeetZone(myPos) && partnerPos !== null && inMeetZone(partnerPos)) {
                    this.pickupState = "DROP";
                    this.log.debug(`PICKUP: TO_MIDPOINT → DROP (both in meet zone)`);
                }
                break;
            }
            case "DROP": {
                if (carried.length === 0) {
                    this.pickupState = "COLLECT";
                    this.log.debug(`PICKUP: DROP → COLLECT (drop complete)`);
                }
                break;
            }
        }
    }

    private buildPickupDesires(desires: GeneratedDesires, beliefs: Beliefs, strategy: GameStrategy): void {
        const myPos = beliefs.agents.getCurrentPosition();
        if (!myPos) return;
        const midpoint = strategy.tiles[0];
        if (!midpoint) return;
        const pickupZone = strategy.pickupZoneCenter ?? midpoint;

        switch (this.pickupState) {
            case "COLLECT": {
                // Only parcels within the pickup area
                const inArea = generateReachParcelDesires(beliefs).filter(d =>
                    manhattanDistance(d.target, pickupZone) <= config.handoff.pickupRadius
                );
                if (inArea.length > 0) {
                    desires.set("REACH_PARCEL", inArea);
                } else {
                    // No in-area parcels — loiter at the pickup zone center
                    desires.set("REACH_TILE", this.meetZoneTiles(beliefs, myPos, pickupZone, strategy.maxDistance));
                }
                break;
            }
            case "TO_MIDPOINT":
                desires.set("REACH_TILE", this.meetZoneTiles(beliefs, myPos, midpoint, strategy.maxDistance));
                break;
            case "DROP": {
                // DELIVER_PARCEL at current position: distance 0 → Infinity score → putdown fires.
                desires.set("DELIVER_PARCEL", [{ type: "DELIVER_PARCEL", target: myPos }]);
                break;
            }
        }
    }

    // ─── DELIVER state machine ────────────────────────────────────────────────

    private tickDeliver(beliefs: Beliefs, strategy: GameStrategy): void {
        const me = beliefs.agents.getCurrentMe();
        if (!me) return;
        const myPos = beliefs.agents.getCurrentPosition();
        if (!myPos) return;
        const midpoint = strategy.tiles[0];
        if (!midpoint) return;

        const carried = beliefs.parcels.getCarriedByAgent(me.id);
        const inMeetZone = (p: { x: number; y: number }) =>
            manhattanDistance(p, midpoint) <= strategy.maxDistance;
        const inZoneParcels = () => beliefs.parcels.getAvailableParcels().filter(p =>
            p.lastPosition !== null && inMeetZone(p.lastPosition)
        );

        switch (this.deliverState) {
            case "WAIT":
                if (inZoneParcels().length > 0) {
                    this.deliverState = "COLLECT_DROP";
                    this.log.debug(`DELIVER: WAIT → COLLECT_DROP (parcels in zone)`);
                }
                break;
            case "COLLECT_DROP":
                if (carried.length > 0) {
                    this.deliverState = "DELIVERING";
                    this.log.debug(`DELIVER: COLLECT_DROP → DELIVERING`);
                } else if (inZoneParcels().length === 0) {
                    this.deliverState = "WAIT";
                    this.log.debug(`DELIVER: COLLECT_DROP → WAIT (zone empty, nothing carried)`);
                }
                break;
            case "DELIVERING":
                if (carried.length === 0) {
                    this.deliverState = "RETURN";
                    this.log.debug(`DELIVER: DELIVERING → RETURN`);
                }
                break;
            case "RETURN":
                if (inMeetZone(myPos)) {
                    this.deliverState = "WAIT";
                    this.log.debug(`DELIVER: RETURN → WAIT`);
                }
                break;
        }
    }

    private buildDeliverDesires(desires: GeneratedDesires, beliefs: Beliefs, strategy: GameStrategy): void {
        const myPos = beliefs.agents.getCurrentPosition();
        if (!myPos) return;
        const midpoint = strategy.tiles[0];
        if (!midpoint) return;

        switch (this.deliverState) {
            case "WAIT":
            case "RETURN":
                desires.set("REACH_TILE", this.meetZoneTiles(beliefs, myPos, midpoint, strategy.maxDistance));
                break;
            case "COLLECT_DROP": {
                // Only grab parcels that are in the meet zone
                const inZone = beliefs.parcels.getAvailableParcels()
                    .filter(p => p.lastPosition !== null &&
                        manhattanDistance(p.lastPosition, midpoint) <= strategy.maxDistance);
                if (inZone.length > 0) {
                    desires.set("REACH_PARCEL", inZone.map(p => ({
                        type: "REACH_PARCEL" as const,
                        target: p.lastPosition!,
                    })));
                }
                break;
            }
            case "DELIVERING": {
                const delivers = generateDeliverDesires(beliefs);
                if (delivers.length > 0) desires.set("DELIVER_PARCEL", delivers);
                break;
            }
        }
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /**
     * Build REACH_TILE desires for reachable tiles in the meet zone.
     * Uses allRendezvousTiles so walls at the exact center tile are handled gracefully.
     * Reward is fixed so the sorter simply picks the nearest zone tile.
     */
    private meetZoneTiles(
        beliefs: Beliefs,
        from: { x: number; y: number },
        center: { x: number; y: number },
        maxDistance: number,
    ): ReachTileDesire[] {
        const tiles = beliefs.map.allRendezvousTiles(from, center.x, center.y, maxDistance);
        return tiles.map(t => ({
            type: "REACH_TILE" as const,
            target: t,
            sourceId: "role",
            reward: 100,
            expiresAt: Infinity,
        }));
    }
}
