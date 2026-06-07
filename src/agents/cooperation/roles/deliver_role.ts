import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { GameStrategy } from "../../../models/game_strategy.js";
import type { GeneratedDesires } from "../../../models/desires.js";
import type { Logger } from "../../../utils/logger.js";
import { generateDeliverDesires } from "../../bdi/desire/desire_generator.js";
import { approachDesire } from "./handoff_geometry.js";

type DeliverState = "WAIT_DROP" | "COLLECT" | "DELIVER" | "RETURN";

/**
 * ZONAL_RELAY/DELIVER_AGENT role FSM.
 *
 * Waits at the approach cell adjacent to exchange tile M until the pickup agent drops there,
 * then picks up and delivers. Repeats continuously.
 *
 *   WAIT_DROP — wait at the approach cell until a parcel appears at M and the carrier has vacated it.
 *   COLLECT   — step onto M and pick up (REACH_PARCEL targeting M).
 *   DELIVER   — carry parcels to a real delivery tile.
 *   RETURN    — navigate back to the approach cell for the next round.
 */
export class DeliverRole {
    private state: DeliverState = "WAIT_DROP";

    constructor(private readonly log: Logger) {}

    reset(): void {
        this.state = "WAIT_DROP";
    }

    tick(beliefs: Beliefs, strategy: GameStrategy): void {
        const me = beliefs.agents.getCurrentMe();
        if (!me) return;
        const myPos = beliefs.agents.getCurrentPosition();
        if (!myPos) return;
        const M = strategy.tiles[0];
        const approachTile = strategy.approachTile;
        if (!M || !approachTile) return;

        const carried = beliefs.parcels.getCarriedByAgent(me.id);
        const parcelAtM = () => beliefs.parcels.getAvailableParcels().some(
            p => p.lastPosition !== null && p.lastPosition.x === M.x && p.lastPosition.y === M.y,
        );

        switch (this.state) {
            case "WAIT_DROP":
                // Trigger as soon as sensing reports the parcel at M. The passer enters LEAVE
                // immediately after dropping, so it won't linger; any brief overlap is handled
                // by the executor's move-fail/retry.
                if (parcelAtM()) {
                    this.state = "COLLECT";
                    this.log.debug(`DELIVER: WAIT_DROP → COLLECT (parcel at M)`);
                }
                break;
            case "COLLECT": {
                if (carried.length > 0 && !parcelAtM()) {
                    this.state = "DELIVER";
                    this.log.debug(`DELIVER: COLLECT → DELIVER (carrying=${carried.length})`);
                } else if (carried.length === 0 && !parcelAtM()) {
                    // Parcel disappeared before pickup — wait for the next drop.
                    this.state = "WAIT_DROP";
                    this.log.debug(`DELIVER: COLLECT → WAIT_DROP (parcel gone, nothing collected)`);
                }
                break;
            }
            case "DELIVER":
                if (carried.length === 0) {
                    this.state = "RETURN";
                    this.log.debug(`DELIVER: DELIVER → RETURN`);
                }
                break;
            case "RETURN":
                if (myPos.x === approachTile.x && myPos.y === approachTile.y) {
                    this.state = "WAIT_DROP";
                    this.log.debug(`DELIVER: RETURN → WAIT_DROP`);
                }
                break;
        }
    }

    buildDesires(beliefs: Beliefs, strategy: GameStrategy): GeneratedDesires {
        const desires: GeneratedDesires = new Map();
        const myPos = beliefs.agents.getCurrentPosition();
        if (!myPos) return desires;
        const M = strategy.tiles[0];
        const approachTile = strategy.approachTile;
        if (!M || !approachTile) return desires;

        switch (this.state) {
            case "WAIT_DROP":
            case "RETURN":
                desires.set("REACH_TILE", [approachDesire(approachTile)]);
                break;
            case "COLLECT":
                // Step onto M and execute the pickup terminal step.
                desires.set("REACH_PARCEL", [{ type: "REACH_PARCEL" as const, target: M }]);
                break;
            case "DELIVER": {
                const delivers = generateDeliverDesires(beliefs);
                if (delivers.length > 0) desires.set("DELIVER_PARCEL", delivers);
                break;
            }
        }

        return desires;
    }
}
