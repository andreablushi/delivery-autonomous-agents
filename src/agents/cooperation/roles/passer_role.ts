import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { GameStrategy } from "../../../models/game_strategy.js";
import type { GeneratedDesires } from "../../../models/desires.js";
import type { Logger } from "../../../utils/logger.js";
import { manhattanDistance } from "../../../utils/metrics.js";
import { meetZoneTiles } from "./meet_zone_tiles.js";

type PasserState = "TO_MEET" | "DROP";

/**
 * OPPORTUNISTIC/PASSER role FSM.
 *
 * States:
 *   TO_MEET — navigate to the meet zone and wait until the partner arrives too.
 *   DROP    — both are in zone; drop all carried parcels in place.
 *
 * Completes once the drop finishes (carried → 0).
 */
export class PasserRole {
    private state: PasserState = "TO_MEET";
    private completed = false;

    constructor(private readonly log: Logger) {}

    reset(): void {
        this.state = "TO_MEET";
        this.completed = false;
    }

    isComplete(): boolean {
        return this.completed;
    }

    tick(beliefs: Beliefs, strategy: GameStrategy): void {
        if (this.completed) return;
        const me = beliefs.agents.getCurrentMe();
        if (!me) return;
        const myPos = beliefs.agents.getCurrentPosition();
        if (!myPos) return;
        const meetTile = strategy.tiles[0];
        if (!meetTile) return;

        const carried = beliefs.parcels.getCarriedByAgent(me.id);
        const inZone = (p: { x: number; y: number }) => manhattanDistance(p, meetTile) <= strategy.maxDistance;

        switch (this.state) {
            case "TO_MEET": {
                if (carried.length === 0) {
                    // Dropped before reaching — strategy is satisfied; complete immediately.
                    this.completed = true;
                    this.log.debug("PASSER: TO_MEET → completed (nothing to carry)");
                    break;
                }
                const partnerPos = beliefs.agents.getCurrentFriends()
                    .find(f => f.id === strategy.partnerId)?.lastPosition ?? null;
                if (inZone(myPos) && partnerPos !== null && inZone(partnerPos)) {
                    this.state = "DROP";
                    this.log.debug("PASSER: TO_MEET → DROP (both in zone)");
                }
                break;
            }
            case "DROP": {
                if (carried.length === 0) {
                    this.completed = true;
                    this.log.debug("PASSER: DROP → completed (drop done)");
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
            case "DROP":
                // Drop in place — DELIVER_PARCEL at the current position.
                desires.set("DELIVER_PARCEL", [{ type: "DELIVER_PARCEL", target: myPos }]);
                break;
        }

        return desires;
    }
}
