import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { GameStrategy } from "../../../models/game_strategy.js";
import type { GeneratedDesires } from "../../../models/desires.js";
import type { Logger } from "../../../utils/logger.js";
import { manhattanDistance, posKey } from "../../../utils/metrics.js";
import { generateReachParcelDesires } from "../../bdi/desire/desire_generator.js";
import { meetZoneTiles } from "./meet_zone_tiles.js";

type PickupState = "COLLECT" | "TO_MIDPOINT" | "DROP";

export class PickupRole {
    private state: PickupState = "COLLECT";

    constructor(private readonly log: Logger) {}

    reset(): void {
        this.state = "COLLECT";
    }

    tick(beliefs: Beliefs, strategy: GameStrategy): void {
        const me = beliefs.agents.getCurrentMe();
        if (!me) return;
        const myPos = beliefs.agents.getCurrentPosition();
        if (!myPos) return;
        const midpoint = strategy.tiles[0];
        if (!midpoint) return;

        const carried = beliefs.parcels.getCarriedByAgent(me.id);
        const inMeetZone = (p: { x: number; y: number }) =>
            manhattanDistance(p, midpoint) <= strategy.maxDistance;

        switch (this.state) {
            case "COLLECT": {
                const carryCapacity = beliefs.agents.getCarryCapacity() ?? Infinity;
                const spawnKeys = new Set(beliefs.map.getSpawnTiles().map(t => posKey(t)));
                const inRegionParcels = beliefs.parcels.getAvailableParcels().filter(p =>
                    p.lastPosition !== null && spawnKeys.has(posKey(p.lastPosition))
                );
                if (carried.length >= carryCapacity) {
                    this.state = "TO_MIDPOINT";
                    this.log.debug(`PICKUP: COLLECT → TO_MIDPOINT (at carry capacity)`);
                } else if (carried.length > 0 && inRegionParcels.length === 0) {
                    this.state = "TO_MIDPOINT";
                    this.log.debug(`PICKUP: COLLECT → TO_MIDPOINT (carrying=${carried.length}, spawn region empty)`);
                }
                break;
            }
            case "TO_MIDPOINT": {
                if (carried.length === 0) {
                    this.state = "COLLECT";
                    this.log.debug(`PICKUP: TO_MIDPOINT → COLLECT (not carrying)`);
                    break;
                }
                const partnerPos = beliefs.agents.getCurrentFriends()
                    .find(f => f.id === strategy.partnerId)?.lastPosition ?? null;
                if (inMeetZone(myPos) && partnerPos !== null && inMeetZone(partnerPos)) {
                    this.state = "DROP";
                    this.log.debug(`PICKUP: TO_MIDPOINT → DROP (partner in zone)`);
                }
                break;
            }
            case "DROP": {
                if (carried.length === 0) {
                    this.state = "COLLECT";
                    this.log.debug(`PICKUP: DROP → COLLECT (drop complete)`);
                }
                break;
            }
        }
    }

    buildDesires(beliefs: Beliefs, strategy: GameStrategy): GeneratedDesires {
        const desires: GeneratedDesires = new Map();
        const myPos = beliefs.agents.getCurrentPosition();
        if (!myPos) return desires;
        const midpoint = strategy.tiles[0];
        if (!midpoint) return desires;
        switch (this.state) {
            case "COLLECT": {
                // Filter to parcels whose last known position is a spawn tile (full region sweep).
                const spawnKeys = new Set(beliefs.map.getSpawnTiles().map(t => posKey(t)));
                const inRegion = generateReachParcelDesires(beliefs).filter(d =>
                    spawnKeys.has(posKey(d.target))
                );
                if (inRegion.length > 0) {
                    desires.set("REACH_PARCEL", inRegion);
                } else {
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
            case "TO_MIDPOINT":
                desires.set("REACH_TILE", meetZoneTiles(beliefs, myPos, midpoint, strategy.maxDistance));
                break;
            case "DROP":
                desires.set("DELIVER_PARCEL", [{ type: "DELIVER_PARCEL", target: myPos }]);
                break;
        }

        return desires;
    }
}
