import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { GameStrategy } from "../../../models/game_strategy.js";
import type { GeneratedDesires } from "../../../models/desires.js";
import type { Logger } from "../../../utils/logger.js";
import type { RoleFSM } from "./role_fsm.js";
import { manhattanDistance } from "../../../utils/metrics.js";
import { approachDesire } from "./helpers/approach_desire.js";

type PasserState = "TO_APPROACH" | "DROP_ENTER" | "LEAVE";

/**
 * Passer role FSM. Deterministic exchange: both agents navigate to distinct cells adjacent to the exchange
 * tile M, wait there, then the carrier executes a tight three-step maneuver:
 *
 *   TO_APPROACH — navigate to approachTile and wait until the receiver is also adjacent to M.
 *   DROP_ENTER  — step onto M and drop (DELIVER_PARCEL targeting M).
 *   LEAVE       — step back to approachTile to vacate M for the receiver.
 *
 * Completes once back at the approach cell; autonomous desires resume.
 */
export class PasserRole implements RoleFSM<PasserState> {
    state: PasserState = "TO_APPROACH";
    private completed = false;

    constructor(private readonly log: Logger) {}

    reset(): void {
        this.state = "TO_APPROACH";
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
        
        const M = strategy.meetTile;
        const approachTile = strategy.approachTile;
        if (!approachTile) {
            this.completed = true;
            this.log.debug("PASSER: completed (no geometry)");
            return;
        }

        const carried = beliefs.parcels.getCarriedByAgent(me.id);

        switch (this.state) {
            case "TO_APPROACH": {
                // Nothing to hand off — skip the exchange entirely.
                if (carried.length === 0) {
                    this.completed = true;
                    this.log.debug("PASSER: TO_APPROACH → completed (nothing to carry)");
                    break;
                }
                const partnerPos = beliefs.agents.getCurrentFriends()
                    .find(f => f.id === strategy.partnerId)?.lastPosition ?? null;
                const atApproach = myPos.x === approachTile.x && myPos.y === approachTile.y;
                const partnerReady = partnerPos !== null && manhattanDistance(partnerPos, M) === 1;
                // Transition to DROP_ENTER once both agents are at their respective approach cells.
                if (atApproach && partnerReady) {
                    this.state = "DROP_ENTER";
                    this.log.debug("PASSER: TO_APPROACH → DROP_ENTER (both at approach cells)");
                }
                break;
            }
            case "DROP_ENTER": {
                // Drop done — step back to vacate M for the receiver.
                if (carried.length === 0) {
                    this.state = "LEAVE";
                    this.log.debug("PASSER: DROP_ENTER → LEAVE (drop done)");
                }
                break;
            }
            case "LEAVE": {
                // Back at the approach cell — handoff complete.
                if (myPos.x === approachTile.x && myPos.y === approachTile.y) {
                    this.completed = true;
                    this.log.debug("PASSER: LEAVE → completed (back at approach cell)");
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
