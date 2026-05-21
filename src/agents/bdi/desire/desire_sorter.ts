import type { Beliefs } from "../belief/beliefs.js";
import type { RuleStore } from "../belief/rule_store.js";
import type {
    DesireType,
    ExploreDesire,
    ReachParcelDesire,
    DeliverParcelDesire,
    ReachTileDesire,
    GeneratedDesires,
} from "../../../models/desires.js";
import type { Position } from "../../../models/position.js";
import { posKey, bfsDistancesFrom } from "../../../utils/metrics.js";
import { MapBeliefs } from "../belief/map_beliefs.js"; // used for static isStaticWalkable
import { IntentionQueue } from "../../../models/intentions.js";
import { projectedRewardAfter } from "./decay.js";


/**
 * Determines the priority tier of a desire type.
 * All active desire types share tier 1 so they compete purely on numeric score.
 * Tier 0 is reserved for future desire types that should always yield to active ones.
 * @param desire The desire to evaluate.
 * @returns The priority tier of the desire, where higher numbers indicate higher priority.
 */
function getPriorityForDesire(desire: DesireType): number {
    if (desire.type === 'REACH_PARCEL' || desire.type === 'DELIVER_PARCEL'
        || desire.type === 'REACH_TILE' || desire.type === 'EXPLORE') return 1;
    return 0;
}

/**
 * Build the ordered desire queue for all candidates generated this cycle.
 *
 * All active desire types (REACH_PARCEL, DELIVER_PARCEL, REACH_TILE, EXPLORE) share the same
 * priority tier and compete purely on numeric score. EXPLORE uses an expected-reward formula
 * so that it can win over low-value or contested parcels rather than always being a fallback.
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

    // Settings needed for decay projection
    const parcelSettings = beliefs.parcels.getSettings();
    const playerSettings = beliefs.agents.getSettings();
    const decayIntervalMs = parcelSettings?.reward_decay_interval ?? 0;
    const movementDurationMs = playerSettings?.movement_duration ?? 0;

    // Goal desires — scored and compared
    const reaches = (desires.get("REACH_PARCEL") ?? []) as ReachParcelDesire[];
    const delivers = (desires.get("DELIVER_PARCEL") ?? []) as DeliverParcelDesire[];

    for (const desire of reaches) {
        queue.push({ desire, score: scoreReachDesire(desire, beliefs, meDist, enemyDists, ruleStore, walkable, movementDurationMs, decayIntervalMs) });
    }
    for (const desire of delivers) {
        queue.push({ desire, score: scoreDeliverDesire(desire, beliefs, meDist, ruleStore, movementDurationMs, decayIntervalMs) });
    }

    const reachTiles = (desires.get("REACH_TILE") ?? []) as ReachTileDesire[];
    for (const desire of reachTiles) {
        queue.push({ desire, score: scoreReachTile(desire, meDist) });
    }

    const explores = (desires.get("EXPLORE") ?? []) as ExploreDesire[];
    const now = Date.now();
    for (const desire of explores) {
        queue.push({ desire, score: scoreExplore(desire, meDist, beliefs, ruleStore, now) });
    }

    // Sort by priority tier first, then by score within the same tier
    return queue.sort((a, b) => getPriorityForDesire(b.desire) - getPriorityForDesire(a.desire) || b.score - a.score);
}

/**
 * Score a REACH_TILE desire as `reward / distance`.
 * Uses the same reward/distance heuristic as REACH_PARCEL so goals compete fairly with parcels.
 */
function scoreReachTile(desire: ReachTileDesire, meDist: Map<string, number>): number {
    const distance = meDist.get(posKey(desire.target));
    if (distance === undefined) return 0; // unreachable
    if (distance === 0) return Infinity;
    return desire.reward / distance;
}

/**
 * Score a REACH_PARCEL desire as expected delivery reward / total travel distance.
 *
 * Models the full pickup-then-deliver trip: agent → parcel → nearest delivery tile.
 * Rewards are projected to delivery time to account for decay; parcel_value, stack_count,
 * and delivery_tile rules are applied to the projected values.
 *
 * Falls back to 0 when the parcel can't be found, is unreachable, no delivery tile is
 * reachable from the parcel position, or the projected effective reward ≤ 0.
 */
function scoreReachDesire(
    desire: ReachParcelDesire,
    beliefs: Beliefs,
    meDist: Map<string, number>,
    enemyDists: Map<string, number>[],
    ruleStore: RuleStore,
    walkable: (from: Position, to: Position) => boolean,
    movementDurationMs: number,
    decayIntervalMs: number,
): number {
    const parcel = beliefs.parcels.getAvailableParcels().find(
        p => p.lastPosition &&
            p.lastPosition.x === desire.target.x &&
            p.lastPosition.y === desire.target.y
    );
    if (!parcel) return 0;

    const parcelKey = posKey(desire.target);
    const dPickup = meDist.get(parcelKey);
    if (dPickup === undefined) return 0; // unreachable
    if (dPickup === 0) return Infinity;

    // BFS from the parcel to find the nearest delivery tile
    const parcelBfs = bfsDistancesFrom(desire.target, walkable);
    const deliveryTiles = beliefs.map.getDeliveryTiles();
    let dDeliver = Infinity;
    let nearestDeliveryTile: Position | null = null;
    for (const tile of deliveryTiles) {
        const d = parcelBfs.get(posKey(tile));
        if (d !== undefined && d < dDeliver) {
            dDeliver = d;
            nearestDeliveryTile = tile;
        }
    }
    if (!nearestDeliveryTile || !isFinite(dDeliver)) return 0;

    const dTotal = dPickup + dDeliver;

    // Project reward of the new parcel to delivery time (it travels the full route)
    const projNew = projectedRewardAfter(parcel.reward, dTotal, movementDurationMs, decayIntervalMs);

    // Project already-carried parcels to delivery time (they only need to survive the delivery leg)
    const me = beliefs.agents.getCurrentMe();
    const carried = me ? beliefs.parcels.getCarriedByAgent(me.id) : [];
    const projCarried = carried.map(p =>
        projectedRewardAfter(p.reward, dDeliver, movementDurationMs, decayIntervalMs)
    );

    // Sum per-parcel effective reward after parcel_value rules applied on projected values
    const hypotheticalCount = carried.length + 1;
    const newEffect = ruleStore.parcelValueEffect(projNew);
    const base = projNew * newEffect.multiplier + newEffect.additive
        + projCarried.reduce((sum, pr) => {
            const { multiplier, additive } = ruleStore.parcelValueEffect(pr);
            return sum + pr * multiplier + additive;
        }, 0);

    // Apply stack and delivery-tile rules
    const stack = ruleStore.stackCountEffect(hypotheticalCount);
    const tile = ruleStore.deliveryTileEffect(nearestDeliveryTile);
    const effective = base * stack.multiplier * tile.multiplier
        + stack.additive + tile.additive;
    if (effective <= 0) return 0;

    // Race factor: discount when an enemy can reach this parcel faster than we can
    let raceFactor = 1;
    if (enemyDists.length > 0) {
        const closestEnemyDist = Math.min(...enemyDists.map(d => d.get(parcelKey) ?? Infinity));
        raceFactor = Math.min(1, closestEnemyDist / dPickup);
    }

    return (effective / dTotal) * raceFactor;
}

/**
 * Score a DELIVER_PARCEL desire applying decay projection, stack_count, delivery_tile, and parcel_value rules.
 * Carried parcel rewards are projected to delivery time to account for decay during travel.
 * Falls back to 0 when nothing is carried, the target is unreachable, or effective score ≤ 0.
 */
function scoreDeliverDesire(
    desire: DeliverParcelDesire,
    beliefs: Beliefs,
    meDist: Map<string, number>,
    ruleStore: RuleStore,
    movementDurationMs: number,
    decayIntervalMs: number,
): number {
    const me = beliefs.agents.getCurrentMe();
    if (!me) return 0;

    const carried = beliefs.parcels.getCarriedByAgent(me.id);
    if (carried.length === 0) return 0;

    const distance = meDist.get(posKey(desire.target));
    if (distance === undefined) return 0; // unreachable

    // Per-parcel value after decay projection and parcel_value rules
    const base = carried.reduce((sum, p) => {
        const projected = projectedRewardAfter(p.reward, distance, movementDurationMs, decayIntervalMs);
        const { multiplier, additive } = ruleStore.parcelValueEffect(projected);
        return sum + projected * multiplier + additive;
    }, 0);

    const stack = ruleStore.stackCountEffect(carried.length);
    const tile = ruleStore.deliveryTileEffect(desire.target);

    const effective = base * stack.multiplier * tile.multiplier
        + stack.additive + tile.additive
        + (desire.bonus ?? 0);
    if (effective <= 0) return 0;

    return effective / (distance + 1);
}

/**
 * Score an ExploreDesire based on expected parcel reward at the target tile, age, cluster weight,
 * and enemy heat. Competes numerically with REACH_PARCEL / DELIVER_PARCEL in the same priority tier.
 *
 * score = expectedReward * clusterWeight * ageNormalized / (distance + 1) / (1 + enemyHeat)
 *
 * expectedReward is derived from parcelSettings.reward_avg and filtered through the parcel_value rule
 * so rules like "parcels > X = no reward" dampen exploration of zones expected to produce such parcels.
 * ageNormalized is capped at 1 using parcel_spawn_interval as the saturation point.
 */
function scoreExplore(
    desire: ExploreDesire,
    meDist: Map<string, number>,
    beliefs: Beliefs,
    ruleStore: RuleStore,
    now: number,
): number {
    const distance = meDist.get(posKey(desire.target));
    if (distance === undefined) return 0; // unreachable

    const settings = beliefs.parcels.getSettings();
    const rewardAvg = settings?.reward_avg ?? 1;
    const spawnInterval = settings?.parcel_spawn_interval;

    const lastSensing = beliefs.map.getSpawnTileSensingTime(desire.target);
    const age = lastSensing !== undefined ? now - lastSensing : Infinity;
    // Cap at 1: tiles unseen for ≥ one spawn cycle are equally "ripe".
    const ageNormalized = (spawnInterval && isFinite(spawnInterval) && spawnInterval > 0)
        ? Math.min(1, age / spawnInterval)
        : 1;

    const { multiplier, additive } = ruleStore.parcelValueEffect(rewardAvg);
    const expectedReward = Math.max(0, rewardAvg * multiplier + additive);
    if (expectedReward <= 0) return 0;

    const clusterWeight = beliefs.map.getSpawnTileClusterWeight(desire.target);
    const weight = clusterWeight > 0 ? clusterWeight : 1;
    const heat = beliefs.agents.getEnemyHeatAt(desire.target);

    return expectedReward * weight * ageNormalized / (distance + 1) / (1 + heat);
}
