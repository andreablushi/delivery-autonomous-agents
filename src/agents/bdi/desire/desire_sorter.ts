import type { Beliefs } from "../belief/beliefs.js";
import type {
    DesireType,
    ExploreDesire,
    ReachParcelDesire,
    DeliverParcelDesire,
    GeneratedDesires,
} from "../../../models/desires.js";
import type { Position } from "../../../models/position.js";
import { posKey, bfsDistancesFrom } from "../../../utils/metrics.js";
import { MapBeliefs } from "../belief/map_beliefs.js"; // used for static isStaticWalkable
import { IntentionQueue } from "../../../models/intentions.js";


/**
 * Determines the priority tier of a desire type.
 * Priority tiers: REACH_PARCEL|DELIVER_PARCEL=1, EXPLORE=0.
 * @param desire The desire to evaluate.
 * @returns The priority tier of the desire, where higher numbers indicate higher priority.
 */
function getPriorityForDesire(desire: DesireType): number {
    if (desire.type === 'REACH_PARCEL' || desire.type === 'DELIVER_PARCEL') return 1;
    return 0;
}

/**
 * Build the ordered desire queue for all candidates generated this cycle.
 *
 * Priority tiers:
 *   1. Goal     - REACH_PARCEL and DELIVER_PARCEL, scored independently and compared.
 *   0. Fallback - EXPLORE (nearest spawn outside the observation range).
 *
 * @param desires Grouped desires from the generator.
 * @param beliefs Current beliefs of the agent.
 * @returns The ordered desire queue, or an empty array if no candidates are available.
 */
export function getIntentionQueue(desires: GeneratedDesires, beliefs: Beliefs): IntentionQueue {
    const queue: IntentionQueue = [];

    const me = beliefs.agents.getCurrentMe();
    if (!me?.lastPosition) return queue;

    const map = beliefs.map.getMap();
    if (!map) return queue;
    const walkable = (from: Position, to: Position) => MapBeliefs.isStaticWalkable(map.tiles, map.width, map.height, from, to);

    // Single BFS from agent position — reused for all desire scoring this tick
    const meDist = bfsDistancesFrom(me.lastPosition, walkable);

    // One BFS per enemy for race factor scoring (typically few enemies)
    const enemies = beliefs.agents.getCurrentEnemies().filter(e => e.lastPosition !== null);
    const enemyDists = enemies.map(e => bfsDistancesFrom(e.lastPosition!, walkable));

    // Goal desires — scored and compared
    const reaches = (desires.get("REACH_PARCEL") ?? []) as ReachParcelDesire[];
    const delivers = (desires.get("DELIVER_PARCEL") ?? []) as DeliverParcelDesire[];

    for (const desire of reaches) {
        queue.push({ desire, score: scoreReachDesire(desire, beliefs, meDist, enemyDists) });
    }
    for (const desire of delivers) {
        queue.push({ desire, score: scoreDeliverDesire(desire, beliefs, meDist) });
    }

    // Fallback to exploration desires
    const explores = (desires.get("EXPLORE") ?? []) as ExploreDesire[];
    const now = Date.now();
    for (const desire of explores) {
        queue.push({ desire, score: scoreExplore(desire, meDist, beliefs, now) });
    }

    // Sort by priority tier first, then by score within the same tier
    return queue.sort((a, b) => getPriorityForDesire(b.desire) - getPriorityForDesire(a.desire) || b.score - a.score);
}

/**
 * Score a REACH_PARCEL desire as `(parcelReward / distance) * raceFactor`.
 * raceFactor = clamp(closestEnemyDistance / ourDistance, 0, 1): penalises parcels
 * where an enemy is closer than us, proportionally to how much closer they are.
 * Falls back to 0 when the parcel can't be matched or the target is unreachable.
 */
function scoreReachDesire(
    desire: ReachParcelDesire,
    beliefs: Beliefs,
    meDist: Map<string, number>,
    enemyDists: Map<string, number>[],
): number {
    const parcel = beliefs.parcels.getAvailableParcels().find(
        p => p.lastPosition &&
            p.lastPosition.x === desire.target.x &&
            p.lastPosition.y === desire.target.y
    );
    if (!parcel) return 0;

    const targetKey = posKey(desire.target);
    const distance = meDist.get(targetKey);
    if (distance === undefined) return 0; // unreachable
    if (distance === 0) return Infinity;

    // Race factor: discount when an enemy can reach this parcel faster than we can.
    // An enemy that cannot reach the parcel poses no threat (treat distance as Infinity).
    let raceFactor = 1;
    if (enemyDists.length > 0) {
        const closestEnemyDist = Math.min(...enemyDists.map(d => d.get(targetKey) ?? Infinity));
        raceFactor = Math.min(1, closestEnemyDist / distance);
    }

    return (parcel.reward / distance) * raceFactor;
}

/**
 * Score a DELIVER_PARCEL desire as `sum(carriedRewards) / (distance + 1)`.
 * Falls back to 0 when nothing is carried or the target is unreachable.
 */
function scoreDeliverDesire(
    desire: DeliverParcelDesire,
    beliefs: Beliefs,
    meDist: Map<string, number>,
): number {
    const me = beliefs.agents.getCurrentMe();
    if (!me) return 0;

    const carriedReward = beliefs.parcels.getCarriedByAgent(me.id).reduce((s, p) => s + p.reward, 0);
    if (carriedReward === 0) return 0;

    const distance = meDist.get(posKey(desire.target)) ?? undefined;
    if (distance === undefined) return 0; // unreachable
    return carriedReward / (distance + 1);
}

/**
 * Score an ExploreDesire based on how long it's been since the target tile was last sensed,
 * adjusted for distance: score = clusterWeight * age / (distance + 1) / (1 + enemyHeat).
 * Tiles that have never been sensed score Infinity and will always be chosen over sensed tiles.
 * Among sensed tiles, those that haven't been sensed for a long time and are closer will score higher.
 * The enemy heat factor penalises tiles near recently-observed enemies.
 */
function scoreExplore(
    desire: ExploreDesire,
    meDist: Map<string, number>,
    beliefs: Beliefs,
    now: number,
): number {
    const distance = meDist.get(posKey(desire.target));
    if (distance === undefined) return 0; // unreachable

    const lastSensing = beliefs.map.getSpawnTileSensingTime(desire.target);
    const age = lastSensing !== undefined ? now - lastSensing : Infinity;

    const clusterWeight = beliefs.map.getSpawnTileClusterWeight(desire.target);
    const weight = clusterWeight > 0 ? clusterWeight : 1;

    const heat = beliefs.agents.getEnemyHeatAt(desire.target);
    return weight * age / (distance + 1) / (1 + heat);
}
