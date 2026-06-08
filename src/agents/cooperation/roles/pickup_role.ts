import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { GameStrategy } from "../../../models/game_strategy.js";
import type { GeneratedDesires } from "../../../models/desires.js";
import type { Logger } from "../../../utils/logger.js";
import type { RoleFSM } from "./role_fsm.js";
import { manhattanDistance, posKey } from "../../../utils/metrics.js";
import { generateReachParcelDesires } from "../../bdi/desire/desire_generator.js";
import { approachDesire } from "./helpers/approach_desire.js";

type PickupState = "COLLECT" | "TO_APPROACH" | "DROP_ENTER" | "LEAVE";

/**
 * Pickup role FSM. Sweeps the spawn region for parcels and then executes a deterministic handoff:
 *
 * Sweeps the spawn region for parcels and then executes a deterministic handoff:
 *
 *   COLLECT     — gather parcels from spawn tiles (all-region sweep + patrol).
 *   TO_APPROACH — navigate to the approach cell adjacent to exchange tile M; wait until the deliver agent is also adjacent to M.
 *   DROP_ENTER  — step onto M and drop (DELIVER_PARCEL targeting M).
 *   LEAVE       — step back to the approach cell, then repeat from COLLECT.
 */
export class PickupRole implements RoleFSM<PickupState> {
    state: PickupState = "COLLECT";

    constructor(private readonly log: Logger) {}

    reset(): void {
        this.state = "COLLECT";
    }

    tick(beliefs: Beliefs, strategy: GameStrategy): void {
        const me = beliefs.agents.getCurrentMe();
        if (!me) return;
        const myPos = beliefs.agents.getCurrentPosition();
        if (!myPos) return;
        const M = strategy.meetTile;
        const approachTile = strategy.approachTile;
        if (!approachTile) return;

        const carried = beliefs.parcels.getCarriedByAgent(me.id);

        switch (this.state) {
            case "COLLECT": {
                // Check if there are any parcels left in the spawn region
                const spawnKeys = new Set(beliefs.map.getSpawnTiles().map(t => posKey(t)));
                const inRegionParcels = beliefs.parcels.getAvailableParcels().filter(p =>
                    p.lastPosition !== null && spawnKeys.has(posKey(p.lastPosition))
                );
                // If we are carrying parcels and the spawn region is empty, transition to TO_APPROACH to head to the handoff
                if (carried.length > 0 && inRegionParcels.length === 0) {
                    this.state = "TO_APPROACH";
                    this.log.debug(`PICKUP: COLLECT → TO_APPROACH (carrying=${carried.length}, spawn region empty)`);
                }
                break;
            }
            case "TO_APPROACH": {
                // If we dropped all parcels, return to COLLECT to sweep for more
                if (carried.length === 0) {
                    this.state = "COLLECT";
                    this.log.debug(`PICKUP: TO_APPROACH → COLLECT (not carrying)`);
                    break;
                }
                const partnerPos = beliefs.agents.getCurrentFriends()
                    .find(f => f.id === strategy.partnerId)?.lastPosition ?? null;
                const atApproach = myPos.x === approachTile.x && myPos.y === approachTile.y;
                const partnerReady = partnerPos !== null && manhattanDistance(partnerPos, M) === 1;
                // Transition to DROP_ENTER once both agents are at their respective approach cells
                if (atApproach && partnerReady) {
                    this.state = "DROP_ENTER";
                    this.log.debug(`PICKUP: TO_APPROACH → DROP_ENTER (both at approach cells)`);
                }
                break;
            }
            case "DROP_ENTER": {
                // If we successfully dropped the parcel, transition to LEAVE to step back and vacate M for the receiver
                if (carried.length === 0) {
                    this.state = "LEAVE";
                    this.log.debug(`PICKUP: DROP_ENTER → LEAVE (drop done)`);
                }
                break;
            }
            case "LEAVE": {
                // Once we step back to the approach cell, transition back to COLLECT to look for more parcels
                if (myPos.x === approachTile.x && myPos.y === approachTile.y) {
                    this.state = "COLLECT";
                    this.log.debug(`PICKUP: LEAVE → COLLECT (back at approach cell)`);
                }
                break;
            }
        }
    }

    buildDesires(beliefs: Beliefs, strategy: GameStrategy): GeneratedDesires {
        const desires: GeneratedDesires = new Map();
        const myPos = beliefs.agents.getCurrentPosition();
        if (!myPos) return desires;
        const M = strategy.meetTile;
        const approachTile = strategy.approachTile;
        if (!approachTile) return desires;

        switch (this.state) {
            case "COLLECT": {
                // Filter to parcels whose last known position is a spawn tile (full region sweep).
                const spawnKeys = new Set(beliefs.map.getSpawnTiles().map(t => posKey(t)));
                const inRegion = generateReachParcelDesires(beliefs).filter(d =>
                    spawnKeys.has(posKey(d.target))
                );
                if (inRegion.length > 0) {
                    desires.set("REACH_PARCEL", inRegion);
                } 
                else {
                    // No visible in-region parcels — patrol spawn tiles so the agent spreads across the region.
                    const spawnTiles = beliefs.map.getSpawnTiles();
                    const expiresAt = Date.now() + 5_000; // short TTL; rebuilt every deliberation cycle
                    const patrol = spawnTiles.map(t => ({
                        type: "REACH_TILE" as const,
                        target: { x: t.x, y: t.y },
                        sourceId: "pickup-sweep",
                        expiresAt,
                        reward: 1,
                    }));
                    if (patrol.length > 0) desires.set("REACH_TILE", patrol);
                }
                break;
            }
            // In TO_APPROACH and LEAVE, navigate to the approach tile and wait there for the handoff
            case "TO_APPROACH":
            case "LEAVE":
                desires.set("REACH_TILE", [approachDesire(approachTile)]);
                break;
            case "DROP_ENTER":
                // Route to M and append a putdown terminal step — drops exactly at M.
                desires.set("DELIVER_PARCEL", [{ type: "DELIVER_PARCEL", target: M }]);
                break;
        }

        return desires;
    }
}
