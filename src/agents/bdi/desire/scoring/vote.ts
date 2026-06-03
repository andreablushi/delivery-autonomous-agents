import type { Beliefs } from "../../belief/beliefs.js";
import type { RuleStore } from "../../belief/rule_store.js";
import type { HoldTileDesire, ReachParcelDesire, DeliverParcelDesire } from "../../../../models/desires.js";
import type { Position } from "../../../../models/position.js";
import { bfsDistancesFrom } from "../../../../utils/metrics.js";
import { MapBeliefs } from "../../belief/map_beliefs.js";
import { carriedEffectiveValue } from "./utils.js";
import { scoreReachDesire } from "./reach_parcel.js";
import { scoreDeliverDesire } from "./deliver_parcel.js";
import { scoreHoldTile } from "./hold_tile.js";

/**
 * Evaluate a rendezvous proposal on behalf of a BDI agent.
 *
 * Returns `true` (accept) iff:
 *   1. The zone is reachable (≥1 candidate tile accessible from the agent's current position), AND
 *   2. The best rendezvous rate-score across candidate tiles ≥ the agent's current best
 *      REACH_PARCEL / DELIVER_PARCEL score.
 *
 * Both sides use (value_preserved_or_gained / distance) units, so the comparison is consistent
 * even when the agent carries a stack.
 */
export function evaluateRendezvousVote(
    beliefs: Beliefs,
    ruleStore: RuleStore,
    rawArgs: unknown,
): boolean {
    if (typeof rawArgs !== "object" || rawArgs === null) return false;
    const obj = rawArgs as Record<string, unknown>;
    const x = typeof obj.x === "number" ? obj.x : null;
    const y = typeof obj.y === "number" ? obj.y : null;
    const max_distance = typeof obj.max_distance === "number" ? obj.max_distance : null;
    const reward = typeof obj.reward === "number" ? obj.reward : null;
    if (x === null || y === null || max_distance === null || reward === null) return false;

    const me = beliefs.agents.getCurrentMe();
    if (!me?.lastPosition) return false;

    const map = beliefs.map.getMap();
    if (!map) return false;

    const walkable = (from: Position, to: Position) =>
        MapBeliefs.isStaticWalkable(map.tiles, map.width, map.height, from, to);
    const meDist = bfsDistancesFrom(me.lastPosition, walkable);

    // Feasibility check
    const tiles = beliefs.map.allRendezvousTiles(me.lastPosition, x, y, max_distance);
    if (tiles.length === 0) return false;

    // Friend BFS for joint bottleneck scoring
    const friends = beliefs.agents.getCurrentFriends().filter(f => f.lastPosition !== null);
    const friendDists = friends.map(f => bfsDistancesFrom(f.lastPosition!, walkable));

    // Enemy BFS for race factor in parcel scoring
    const enemies = beliefs.agents.getCurrentEnemies().filter(e => e.lastPosition !== null);
    const enemyDists = enemies.map(e => {
        const pos = { x: Math.round(e.lastPosition!.x), y: Math.round(e.lastPosition!.y) };
        return bfsDistancesFrom(pos, walkable);
    });

    const carried = beliefs.parcels.getCarriedByAgent(me.id);
    const carriedCount = carried.length;
    const carriedValue = carriedEffectiveValue(carried, ruleStore);

    // Best rendezvous score across candidate tiles
    let rendezvousScore = 0;
    for (const tile of tiles) {
        const hold: HoldTileDesire = {
            type: "HOLD_TILE",
            target: tile,
            sourceId: "vote",
            reward,
            releaseZone: { center: { x, y }, maxDistance: max_distance },
        };
        rendezvousScore = Math.max(rendezvousScore, scoreHoldTile(hold, meDist, beliefs, friendDists, carriedValue));
    }

    // Best current parcel/delivery score
    let bestParcelScore = 0;
    const parcelDesires: ReachParcelDesire[] = beliefs.parcels.getAvailableParcels()
        .filter(p => p.lastPosition !== null)
        .map(p => ({ type: "REACH_PARCEL" as const, target: p.lastPosition! }));
    for (const desire of parcelDesires) {
        bestParcelScore = Math.max(
            bestParcelScore,
            scoreReachDesire(desire, beliefs, meDist, enemyDists, ruleStore, carriedValue, carriedCount),
        );
    }
    if (carriedCount > 0) {
        const deliveryDesires: DeliverParcelDesire[] = beliefs.map.getDeliveryTiles().map(tile => ({
            type: "DELIVER_PARCEL" as const,
            target: { x: tile.x, y: tile.y },
        }));
        for (const desire of deliveryDesires) {
            bestParcelScore = Math.max(
                bestParcelScore,
                scoreDeliverDesire(desire, beliefs, meDist, ruleStore, carriedValue, carriedCount),
            );
        }
    }

    return rendezvousScore >= bestParcelScore;
}
