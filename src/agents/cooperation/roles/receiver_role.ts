import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { GameStrategy } from "../../../models/game_strategy.js";
import type { GeneratedDesires } from "../../../models/desires.js";
import type { Logger } from "../../../utils/logger.js";
import type { RoleFSM } from "./role_fsm.js";
import { generateDeliverDesires } from "../../bdi/desire/desire_generator.js";
import { approachDesire } from "./helpers/approach_desire.js";

type ReceiverState = "WAIT_DROP" | "COLLECT" | "DELIVER";

/**
 * OPPORTUNISTIC/RECEIVER role FSM.
 *
 * Deterministic exchange: waits on the approach cell adjacent to the exchange tile M until
 * the carrier drops there and vacates it, then steps on M to pick up and delivers.
 *
 *   WAIT_DROP — navigate to approachTile and hold until a parcel appears at M and the
 *               carrier has stepped off (no friend on M).
 *   COLLECT   — step onto M and pick up (REACH_PARCEL targeting M).
 *   DELIVER   — carry parcels to a real delivery tile.
 *
 * Completes once delivery is done.
 */
export class ReceiverRole implements RoleFSM<ReceiverState> {
    state: ReceiverState = "WAIT_DROP";
    private done = false;

    constructor(private readonly log: Logger) {}

    reset(): void {
        this.state = "WAIT_DROP";
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
        const M = strategy.meetTile;
        const approachTile = strategy.approachTile;
        if (!approachTile) {
            this.done = true;
            this.log.debug("RECEIVER: done (no geometry)");
            return;
        }

        const carried = beliefs.parcels.getCarriedByAgent(me.id);
        const parcelAtM = () => beliefs.parcels.getAvailableParcels().some(
            p => p.lastPosition !== null && p.lastPosition.x === M.x && p.lastPosition.y === M.y,
        );

        switch (this.state) {
            case "WAIT_DROP": {
                // Transition to COLLECT once a parcel appears at M; the passer steps off right after dropping.
                if (parcelAtM()) {
                    this.state = "COLLECT";
                    this.log.debug("RECEIVER: WAIT_DROP → COLLECT (parcel at M)");
                }
                break;
            }
            case "COLLECT": {
                // Parcel collected and gone from M — proceed to deliver.
                if (carried.length > 0 && !parcelAtM()) {
                    this.state = "DELIVER";
                    this.log.debug(`RECEIVER: COLLECT → DELIVER (carrying=${carried.length})`);
                // Parcel vanished before pickup — wait for the passer to retry.
                } else if (carried.length === 0 && !parcelAtM()) {
                    this.state = "WAIT_DROP";
                    this.log.debug("RECEIVER: COLLECT → WAIT_DROP (parcel gone, nothing collected)");
                }
                break;
            }
            case "DELIVER": {
                // Delivery complete — FSM done.
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
        const M = strategy.meetTile;
        const approachTile = strategy.approachTile;
        if (!approachTile) return desires;

        switch (this.state) {
            case "WAIT_DROP":
                desires.set("REACH_TILE", [approachDesire(approachTile)]);
                break;
            case "COLLECT":
                // Step onto M and pick up.
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
