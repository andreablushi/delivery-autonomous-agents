import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { GameStrategy } from "../../../models/game_strategy.js";
import type { GeneratedDesires } from "../../../models/desires.js";
import type { Logger } from "../../../utils/logger.js";
import { manhattanDistance } from "../../../utils/metrics.js";
import { generateDeliverDesires } from "../../bdi/desire/desire_generator.js";
import { meetZoneTiles } from "./meet_zone_tiles.js";

type ReceiverState = "TO_MEET" | "COLLECT" | "DELIVER";

/**
 * OPPORTUNISTIC/RECEIVER role FSM.
 *
 * States:
 *   TO_MEET — navigate to the meet zone and wait for the passer to drop.
 *   COLLECT — collect the parcels the passer dropped in the zone.
 *   DELIVER — deliver collected parcels to a real delivery tile.
 *
 * Completes once delivery is done (carried → 0 in DELIVER state).
 */
export class ReceiverRole {
    private state: ReceiverState = "TO_MEET";
    private done = false;

    constructor(private readonly log: Logger) {}

    reset(): void {
        this.state = "TO_MEET";
        this.done = false;
    }

    isComplete(): boolean {
        return this.done;
    }

    tick(beliefs: Beliefs, strategy: GameStrategy): void {
        if (this.done) return;
        const me = beliefs.agents.getCurrentMe();
        if (!me) return;
        const myPos = beliefs.agents.getCurrentPosition();
        if (!myPos) return;
        const meetTile = strategy.tiles[0];
        if (!meetTile) return;

        const carried = beliefs.parcels.getCarriedByAgent(me.id);
        const inZone = (p: { x: number; y: number }) => manhattanDistance(p, meetTile) <= strategy.maxDistance;
        const inZoneParcels = () => beliefs.parcels.getAvailableParcels().filter(p =>
            p.lastPosition !== null && inZone(p.lastPosition)
        );

        switch (this.state) {
            case "TO_MEET": {
                // Passer drops and immediately completes/leaves, so we cannot require the partner
                // to still be in zone. Transition as soon as we are in the zone and parcels are
                // present — their presence is proof the passer already dropped.
                if (inZone(myPos) && inZoneParcels().length > 0) {
                    this.state = "COLLECT";
                    this.log.debug("RECEIVER: TO_MEET → COLLECT (parcels in zone)");
                }
                break;
            }
            case "COLLECT": {
                if (carried.length > 0 && inZoneParcels().length === 0) {
                    this.state = "DELIVER";
                    this.log.debug(`RECEIVER: COLLECT → DELIVER (carrying=${carried.length})`);
                } else if (carried.length === 0 && inZoneParcels().length === 0) {
                    // Zone empty and nothing picked up — passer may not have dropped yet or parcels
                    // were taken by someone else. Step back and wait.
                    this.state = "TO_MEET";
                    this.log.debug("RECEIVER: COLLECT → TO_MEET (zone emptied, nothing collected)");
                }
                break;
            }
            case "DELIVER": {
                if (carried.length === 0) {
                    this.done = true;
                    this.log.debug("RECEIVER: DELIVER → done");
                }
                break;
            }
        }
    }

    buildDesires(beliefs: Beliefs, strategy: GameStrategy): GeneratedDesires {
        const desires: GeneratedDesires = new Map();
        const myPos = beliefs.agents.getCurrentPosition();
        if (!myPos) return desires;
        const meetTile = strategy.tiles[0];
        if (!meetTile) return desires;

        switch (this.state) {
            case "TO_MEET":
                desires.set("REACH_TILE", meetZoneTiles(beliefs, myPos, meetTile, strategy.maxDistance));
                break;
            case "COLLECT": {
                const inZone = beliefs.parcels.getAvailableParcels().filter(p =>
                    p.lastPosition !== null &&
                    manhattanDistance(p.lastPosition, meetTile) <= strategy.maxDistance
                );
                if (inZone.length > 0) {
                    desires.set("REACH_PARCEL", inZone.map(p => ({
                        type: "REACH_PARCEL" as const,
                        target: p.lastPosition!,
                    })));
                }
                break;
            }
            case "DELIVER": {
                const delivers = generateDeliverDesires(beliefs);
                if (delivers.length > 0) desires.set("DELIVER_PARCEL", delivers);
                break;
            }
        }

        return desires;
    }
}
