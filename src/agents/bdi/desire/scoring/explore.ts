import type { Beliefs } from "../../belief/beliefs.js";
import type { RuleStore } from "../rule_store.js";
import type { ExploreDesire } from "../../../../models/desires.js";
import { penalizedDistance } from "./utils.js";
import { posKey } from "../../../../utils/metrics.js";

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
export function scoreExplore(
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
