import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { GameStrategy } from "../../../models/game_strategy.js";
import type { GeneratedDesires } from "../../../models/desires.js";
import type { Logger } from "../../../utils/logger.js";
import { manhattanDistance } from "../../../utils/metrics.js";
import { generateReachParcelDesires } from "../../bdi/desire/desire_generator.js";
import { config } from "../../../config.js";
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
                const pickupZone = strategy.pickupZoneCenter ?? midpoint;
                const inAreaParcels = beliefs.parcels.getAvailableParcels().filter(p =>
                    p.lastPosition !== null &&
                    manhattanDistance(p.lastPosition, pickupZone) <= config.handoff.pickupRadius
                );
                if (carried.length >= carryCapacity) {
                    this.state = "TO_MIDPOINT";
                    this.log.debug(`PICKUP: COLLECT → TO_MIDPOINT (at carry capacity)`);
                } else if (carried.length > 0 && inAreaParcels.length === 0) {
                    this.state = "TO_MIDPOINT";
                    this.log.debug(`PICKUP: COLLECT → TO_MIDPOINT (carrying=${carried.length}, area empty)`);
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
        const pickupZone = strategy.pickupZoneCenter ?? midpoint;

        switch (this.state) {
            case "COLLECT": {
                const inArea = generateReachParcelDesires(beliefs).filter(d =>
                    manhattanDistance(d.target, pickupZone) <= config.handoff.pickupRadius
                );
                if (inArea.length > 0) {
                    desires.set("REACH_PARCEL", inArea);
                } else {
                    desires.set("REACH_TILE", meetZoneTiles(beliefs, myPos, pickupZone, strategy.maxDistance));
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
