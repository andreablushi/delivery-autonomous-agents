import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { GameStrategy } from "../../../models/game_strategy.js";
import type { GeneratedDesires } from "../../../models/desires.js";
import type { Logger } from "../../../utils/logger.js";
import type { RoleFSM } from "./role_fsm.js";
import { generateDeliverDesires } from "../../bdi/desire/desire_generator.js";
import { approachDesire } from "./helpers/approach_desire.js";

type DeliverState = "WAIT_DROP" | "COLLECT" | "DELIVER" | "RETURN";

/**
 * Deliver role FSM. Waits at the approach cell adjacent to 
 * exchange tile M until the pickup agent drops there, then picks 
 * up and delivers. Repeats continuously.
 *
 *   WAIT_DROP — wait at the approach cell until a parcel appears at M and the carrier has vacated it.
 *   COLLECT   — step onto M and pick up (REACH_PARCEL targeting M).
 *   DELIVER   — carry parcels to a real delivery tile.
 *   RETURN    — navigate back to the approach cell for the next round.
 */
export class DeliverRole implements RoleFSM<DeliverState> {
    // Initialize in WAIT_DROP so that the agent will head to the approach cell on spawn/sync
    state: DeliverState = "WAIT_DROP";

    constructor(private readonly log: Logger) {}

    reset(): void {
        this.state = "WAIT_DROP";
    }

    tick(beliefs: Beliefs, strategy: GameStrategy): void {
        // Retrieve necessary info from beliefs and strategy
        const me = beliefs.agents.getCurrentMe();
        if (!me) return;
        const myPos = beliefs.agents.getCurrentPosition();
        if (!myPos) return;
        const M = strategy.meetTile;
        const approachTile = strategy.approachTile;
        if (!approachTile) return;
        const carried = beliefs.parcels.getCarriedByAgent(me.id);
        
        // Helper to check if a parcel is currently at M (available to pick up)
        const parcelAtM = () => beliefs.parcels.getAvailableParcels().some(
            parcel => parcel.lastPosition !== null && parcel.lastPosition.x === M.x && parcel.lastPosition.y === M.y,
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
                // If we successfully picked up the parcel, transition to DELIVER
                if (carried.length > 0 && !parcelAtM()) {
                    this.state = "DELIVER";
                    this.log.debug(`DELIVER: COLLECT → DELIVER (carrying=${carried.length})`);

                }
                // If the parcel disappears before we pick it up, return to WAIT_DROP to wait for the next drop.
                else if (carried.length === 0 && !parcelAtM()) {
                    this.state = "WAIT_DROP";
                    this.log.debug(`DELIVER: COLLECT → WAIT_DROP (parcel gone, nothing collected)`);
                }
                break;
            }
            case "DELIVER":
                // If we've delivered the parcel (no longer carrying it), 
                // go back to the approach tile for the next round.
                if (carried.length === 0) {
                    this.state = "RETURN";
                    this.log.debug(`DELIVER: DELIVER → RETURN`);
                }
                break;
            case "RETURN":
                // Once we reach the approach tile, transition back to WAIT_DROP to wait for the next drop
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
        const M = strategy.meetTile;
        const approachTile = strategy.approachTile;
        if (!approachTile) return desires;

        switch (this.state) {
            // In WAIT_DROP and RETURN, navigate to the approach tile and wait there for the next drop
            case "WAIT_DROP":
            case "RETURN":
                desires.set("REACH_TILE", [approachDesire(approachTile)]);
                break;
            // Step onto M and execute the pickup terminal step
            case "COLLECT":    
                desires.set("REACH_PARCEL", [{ type: "REACH_PARCEL" as const, target: M }]);
                break;
            // In DELIVER, generate desires for delivering to any valid delivery tile
            case "DELIVER": {
                const delivers = generateDeliverDesires(beliefs);
                if (delivers.length > 0) desires.set("DELIVER_PARCEL", delivers);
                break;
            }
        }

        return desires;
    }
}
