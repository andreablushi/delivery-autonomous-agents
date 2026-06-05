import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { GameStrategy } from "../../../models/game_strategy.js";
import type { GeneratedDesires } from "../../../models/desires.js";
import type { Logger } from "../../../utils/logger.js";
import { manhattanDistance } from "../../../utils/metrics.js";
import { generateDeliverDesires } from "../../bdi/desire/desire_generator.js";
import { meetZoneTiles } from "./meet_zone_tiles.js";

type DeliverState = "WAIT" | "COLLECT_DROP" | "DELIVERING" | "RETURN";

export class DeliverRole {
    private state: DeliverState = "WAIT";

    constructor(private readonly log: Logger) {}

    reset(): void {
        this.state = "WAIT";
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
        const inZoneParcels = () => beliefs.parcels.getAvailableParcels().filter(p =>
            p.lastPosition !== null && inMeetZone(p.lastPosition)
        );

        switch (this.state) {
            case "WAIT":
                if (inZoneParcels().length > 0) {
                    this.state = "COLLECT_DROP";
                    this.log.debug(`DELIVER: WAIT → COLLECT_DROP (parcels in zone)`);
                }
                break;
            case "COLLECT_DROP":
                if (carried.length > 0) {
                    this.state = "DELIVERING";
                    this.log.debug(`DELIVER: COLLECT_DROP → DELIVERING`);
                } else if (inZoneParcels().length === 0) {
                    this.state = "WAIT";
                    this.log.debug(`DELIVER: COLLECT_DROP → WAIT (zone empty, nothing carried)`);
                }
                break;
            case "DELIVERING":
                if (carried.length === 0) {
                    this.state = "RETURN";
                    this.log.debug(`DELIVER: DELIVERING → RETURN`);
                }
                break;
            case "RETURN":
                if (inMeetZone(myPos)) {
                    this.state = "WAIT";
                    this.log.debug(`DELIVER: RETURN → WAIT`);
                }
                break;
        }
    }

    buildDesires(beliefs: Beliefs, strategy: GameStrategy): GeneratedDesires {
        const desires: GeneratedDesires = new Map();
        const myPos = beliefs.agents.getCurrentPosition();
        if (!myPos) return desires;
        const midpoint = strategy.tiles[0];
        if (!midpoint) return desires;

        switch (this.state) {
            case "WAIT":
            case "RETURN":
                desires.set("REACH_TILE", meetZoneTiles(beliefs, myPos, midpoint, strategy.maxDistance));
                break;
            case "COLLECT_DROP": {
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

        return desires;
    }
}
