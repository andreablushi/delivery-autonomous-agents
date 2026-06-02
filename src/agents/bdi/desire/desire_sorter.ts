import type { Beliefs } from "../belief/beliefs.js";
import type { RuleStore } from "../belief/rule_store.js";
import type {
    DesireType,
    ExploreDesire,
    ReachParcelDesire,
    DeliverParcelDesire,
    ReachTileDesire,
    HoldTileDesire,
    GeneratedDesires,
} from "../../../models/desires.js";
import type { Position } from "../../../models/position.js";
import { posKey, bfsDistancesFrom } from "../../../utils/metrics.js";
import { MapBeliefs } from "../belief/map_beliefs.js"; // used for static isStaticWalkable
import { IntentionQueue } from "../../../models/intentions.js";


/**
 * Build the ordered desire queue for all candidates generated this cycle.
 *
 * REACH_PARCEL, DELIVER_PARCEL, and REACH_TILE are always at priority tier 1.
 * EXPLORE is at tier 1 only when a positive stack_count rule is active (multiplier > 1 or
 * additive > 0) and the expected stack reward is positive at the agent's current carry count + 1;
 * otherwise it falls to tier 0 so goal desires always win.
 *
 * @param desires Grouped desires from the generator.
 * @param beliefs Current beliefs of the agent.
 * @param ruleStore Active scoring rules; applied when scoring REACH_PARCEL, DELIVER_PARCEL, and EXPLORE.
 * @returns The ordered desire queue, or an empty array if no candidates are available.
 */
export function getIntentionQueue(desires: GeneratedDesires, beliefs: Beliefs, ruleStore: RuleStore): IntentionQueue {
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
    const enemyDists = enemies.map(e => {
        const pos = { x: Math.round(e.lastPosition!.x), y: Math.round(e.lastPosition!.y) };
        return bfsDistancesFrom(pos, walkable);
    });

    // One BFS per friend with a known position, used for joint rendezvous scoring
    const friends = beliefs.agents.getCurrentFriends().filter(f => f.lastPosition !== null);
    const friendDists = friends.map(f => bfsDistancesFrom(f.lastPosition!, walkable));

    // Goal desires — always priority tier 1
    const reaches = (desires.get("REACH_PARCEL") ?? []) as ReachParcelDesire[];
    const delivers = (desires.get("DELIVER_PARCEL") ?? []) as DeliverParcelDesire[];

    for (const desire of reaches) {
        queue.push({ desire, score: scoreReachDesire(desire, beliefs, meDist, enemyDists, ruleStore), priority: 1 });
    }
    for (const desire of delivers) {
        queue.push({ desire, score: scoreDeliverDesire(desire, beliefs, meDist, ruleStore), priority: 1 });
    }

    const reachTiles = (desires.get("REACH_TILE") ?? []) as ReachTileDesire[];
    for (const desire of reachTiles) {
        queue.push({ desire, score: scoreReachTile(desire, meDist, beliefs), priority: 1 });
    }

    const holdTiles = (desires.get("HOLD_TILE") ?? []) as HoldTileDesire[];
    for (const desire of holdTiles) {
        queue.push({ desire, score: scoreHoldTile(desire, meDist, beliefs, friendDists), priority: 1 });
    }

    const explores = (desires.get("EXPLORE") ?? []) as ExploreDesire[];
    const now = Date.now();
    const hasPositiveStack = ruleStore.hasPositiveStackRule();
    for (const desire of explores) {
        const { score, priority } = scoreExplore(desire, meDist, beliefs, ruleStore, now, hasPositiveStack);
        queue.push({ desire, score, priority });
    }

    // Sort by priority tier first, then by score within the same tier
    return queue.sort((a, b) => b.priority - a.priority || b.score - a.score);
}

/** Adds the tile penalty at `target` to `distance`, making penalized targets look farther away. */
function penalizedDistance(distance: number, target: Position, beliefs: Beliefs): number {
    return distance + beliefs.map.getTilePenalty(target);
}

/**
 * Score a REACH_TILE desire as `reward / distance`.
 * Uses the same reward/distance heuristic as REACH_PARCEL so goals compete fairly with parcels.
 */
function scoreReachTile(desire: ReachTileDesire, meDist: Map<string, number>, beliefs: Beliefs): number {
    const distance = meDist.get(posKey(desire.target));
    if (distance === undefined) return 0; // unreachable
    if (distance === 0) return Infinity;
    return desire.reward / penalizedDistance(distance, desire.target, beliefs);
}

/**
 * Score a HOLD_TILE desire.
 *
 * Red-light holds (no releaseZone): `reward / penalizedDistance` — identical to REACH_TILE.
 * Returns Infinity when already at the target so the hold anchors the agent there.
 *
 * Rendezvous holds (releaseZone present): `reward / max(distSelf, maxFriendDist)` — the
 * effective meeting time is the bottleneck across all agents. Both agents evaluate the same
 * formula independently, so they converge on the joint-optimal tile. Tiles unreachable by
 * any friend score 0 so the agent never waits at a spot a friend cannot reach.
 * Falls back to individual scoring when no friend positions are known.
 */
function scoreHoldTile(
    desire: HoldTileDesire,
    meDist: Map<string, number>,
    beliefs: Beliefs,
    friendDists: Map<string, number>[],
): number {
    const distance = meDist.get(posKey(desire.target));
    if (distance === undefined) return 0; // unreachable
    if (distance === 0) return Infinity;

    if (desire.releaseZone && friendDists.length > 0) {
        const key = posKey(desire.target);
        const maxFriendDist = Math.max(...friendDists.map(fd => fd.get(key) ?? Infinity));
        const meetingTime = Math.max(distance, maxFriendDist);
        if (!isFinite(meetingTime)) return 0; // a friend cannot reach this tile
        return desire.reward / meetingTime;
    }

    return desire.reward / penalizedDistance(distance, desire.target, beliefs);
}

/**
 * Score a REACH_PARCEL desire based on effective reward after rules, distance, and enemy competition.
 * Falls back to 0 when the parcel is no longer available, unreachable, effective score ≤ 0, or an enemy can reach it faster.
 */
function scoreReachDesire(
    desire: ReachParcelDesire,
    beliefs: Beliefs,
    meDist: Map<string, number>,
    enemyDists: Map<string, number>[],
    ruleStore: RuleStore,
): number {
    // Retrieve the Parcel object corresponding to this desire's target position. 
    // If no parcel is currently believed to be at this position, return 0 so the desire is ignored. 
    const desireParcel = beliefs.parcels.getAvailableParcels().find(
        p => p.lastPosition &&
            p.lastPosition.x === desire.target.x &&
            p.lastPosition.y === desire.target.y
    );
    if (!desireParcel) return 0;

    const parcelPositionKey = posKey(desire.target);
    const distancePickup = meDist.get(parcelPositionKey);
    // If the parcel is unreachable, the score is 0 so the agent ignores this desire
    if (distancePickup === undefined) return 0; // unreachable
    // If we're already on the parcel, this desire should be our top priority so return Infinity to break all ties in favor of pickup
    if (distancePickup === 0) return Infinity;

    const me = beliefs.agents.getCurrentMe();
    const carried = me ? beliefs.parcels.getCarriedByAgent(me.id) : [];

    // Sum per-parcel effective reward after parcel_value rules applied on raw values
    const parcelValueEffect = ruleStore.parcelValueEffect(desireParcel.reward);
    const baseScore = desireParcel.reward * parcelValueEffect.multiplier + parcelValueEffect.additive
        // We sum also the effects of currently carried parcels to make it comparable with the DeliverDesire scoring
        + carried.reduce((sum, p) => {
            const parcelValueEffect = ruleStore.parcelValueEffect(p.reward);
            return sum + p.reward * parcelValueEffect.multiplier + parcelValueEffect.additive;
        }, 0);

    // Apply stack and delivery-tile rules
    const hypotheticalCount = carried.length + 1;
    const stackEffect = ruleStore.stackCountEffect(hypotheticalCount);
    const effectiveScore = baseScore * stackEffect.multiplier + stackEffect.additive;
    if (effectiveScore <= 0) return 0;

    // Race factor: discount when an enemy can reach this parcel faster than we can
    let raceFactor = 1;
    if (enemyDists.length > 0) {
        const closestEnemyDist = Math.min(...enemyDists.map(d => d.get(parcelPositionKey) ?? Infinity));
        raceFactor = Math.min(1, closestEnemyDist / distancePickup);
    }

    return (effectiveScore / penalizedDistance(distancePickup, desire.target, beliefs)) * raceFactor;
}

/**
 * Score a DELIVER_PARCEL desire applying stack_count, delivery_tile, and parcel_value rules on raw rewards.
 * Falls back to 0 when nothing is carried, the target is unreachable, or effective score ≤ 0.
 */
function scoreDeliverDesire(
    desire: DeliverParcelDesire,
    beliefs: Beliefs,
    meDist: Map<string, number>,
    ruleStore: RuleStore,
): number {
    const me = beliefs.agents.getCurrentMe();
    if (!me) return 0;

    // If the agent is not currently carrying any parcels, the score is 0 so the agent ignores this desire
    const carriedParcels = beliefs.parcels.getCarriedByAgent(me.id);
    if (carriedParcels.length === 0) return 0;

    const distance = meDist.get(posKey(desire.target));
    if (distance === undefined) return 0; // unreachable
    if (distance === 0) return Infinity;

    // Per-parcel value after parcel_value rules applied on raw values
    // It consider the fact that delivering a parcel with score higher than a value returns 0
    const baseScore = carriedParcels.reduce((sum, p) => {
        const parcelValueEffect =  ruleStore.parcelValueEffect(p.reward);
        return sum + p.reward * parcelValueEffect.multiplier + parcelValueEffect.additive;
    }, 0);

    const stackEffect = ruleStore.stackCountEffect(carriedParcels.length);
    const tileEffect = ruleStore.deliveryTileEffect(desire.target);
    const effectiveScore = baseScore * stackEffect.multiplier * tileEffect.multiplier
        + stackEffect.additive + tileEffect.additive
        + (desire.bonus ?? 0);
    if (effectiveScore <= 0) return 0;

    return effectiveScore / penalizedDistance(distance, desire.target, beliefs);
}

/**
 * Score an ExploreDesire and assign its priority tier.
 *
 * Two regimes:
 *
 * No positive stack rule (or effective stack reward ≤ 0 for the agent's next pickup):
 *   priority = 0; score = clusterWeight * ageNormalized / (distance + 1) / (1 + enemyHeat)
 *   EXPLORE acts as a low-priority fallback, always yielding to goal desires.
 *
 * Positive stack rule active and expected reward > 0:
 *   priority = 1; score = expectedStackReward * clusterWeight * ageNormalized / (distance + 1) / (1 + enemyHeat)
 *   EXPLORE competes numerically with DELIVER_PARCEL / REACH_PARCEL to encourage building stacks.
 *   expectedStackReward = reward_avg * (carriedCount + 1) * stackEffect.multiplier + stackEffect.additive
 *
 * ageNormalized is capped at 1 using parcel_spawn_interval as the saturation point.
 */
function scoreExplore(
    desire: ExploreDesire,
    meDist: Map<string, number>,
    beliefs: Beliefs,
    ruleStore: RuleStore,
    now: number,
    hasPositiveStack: boolean,
): { score: number; priority: number } {
    const distance = meDist.get(posKey(desire.target));
    if (distance === undefined) return { score: 0, priority: 0 };

    const settings = beliefs.parcels.getSettings();
    const spawnInterval = settings?.parcel_spawn_interval;

    const lastSensing = beliefs.map.getSpawnTileSensingTime(desire.target);
    const age = lastSensing !== undefined ? now - lastSensing : Infinity;
    // Cap at 1: tiles unseen for ≥ one spawn cycle are equally "ripe".
    const ageNormalized = (spawnInterval && isFinite(spawnInterval) && spawnInterval > 0)
        ? Math.min(1, age / spawnInterval)
        : 1;

    const clusterWeight = beliefs.map.getSpawnTileClusterWeight(desire.target);
    const weight = clusterWeight > 0 ? clusterWeight : 1;
    const heat = beliefs.agents.getEnemyHeatAt(desire.target);
    const legacyScore = weight * ageNormalized / (penalizedDistance(distance, desire.target, beliefs) + 1) / (1 + heat);

    // If no positive stack rule is active or positive behave normally
    if (!hasPositiveStack) {
        return { score: legacyScore, priority: 0 };
    }

    const me = beliefs.agents.getCurrentMe();
    const carried = me ? beliefs.parcels.getCarriedByAgent(me.id) : [];
    const targetCount = carried.length + 1;
    const stackEffect = ruleStore.stackCountEffect(targetCount);

    if ((stackEffect.multiplier ?? 1) <= 1 && (stackEffect.additive ?? 0) <= 0) {
        return { score: legacyScore, priority: 0 };
    }

    const rewardAvg = settings?.reward_avg ?? 1;
    const expectedStackReward = rewardAvg * targetCount * (stackEffect.multiplier ?? 1) + (stackEffect.additive ?? 0);

    if (expectedStackReward <= 0) {
        return { score: legacyScore, priority: 0 };
    }

    return {
        score: expectedStackReward * weight * ageNormalized / (penalizedDistance(distance, desire.target, beliefs) + 1) / (1 + heat),
        priority: 1,
    };
}
