import type { Beliefs } from "../../belief/beliefs.js";
import type { RuleStore } from "../../belief/rule_store.js";
import type { ReachParcelDesire } from "../../../../models/desires.js";
import { posKey } from "../../../../utils/metrics.js";
import { penalizedDistance } from "./utils.js";

/**
 * Score a REACH_PARCEL desire based on effective reward after rules, distance, and enemy competition.
 * `carriedValue` (sum of effective values of already-held parcels) is included in the numerator
 * so the score is on the same scale as DELIVER_PARCEL and non-parcel goals.
 * Falls back to 0 when the parcel is no longer available, unreachable, effective score ≤ 0, or
 * an enemy can reach it faster.
 */
export function scoreReachDesire(
    desire: ReachParcelDesire,
    beliefs: Beliefs,
    meDist: Map<string, number>,
    enemyDists: Map<string, number>[],
    ruleStore: RuleStore,
    carriedValue: number,
    carriedCount: number,
): number {
    const desireParcel = beliefs.parcels.getAvailableParcels().find(
        p => p.lastPosition &&
            p.lastPosition.x === desire.target.x &&
            p.lastPosition.y === desire.target.y
    );
    if (!desireParcel) return 0;

    const parcelPositionKey = posKey(desire.target);
    const distancePickup = meDist.get(parcelPositionKey);
    if (distancePickup === undefined) return 0; // unreachable
    if (distancePickup === 0) return Infinity;

    const parcelValueEffect = ruleStore.parcelValueEffect(desireParcel.reward);
    const baseScore = desireParcel.reward * parcelValueEffect.multiplier + parcelValueEffect.additive
        + carriedValue;

    const hypotheticalCount = carriedCount + 1;
    const stackEffect = ruleStore.stackCountEffect(hypotheticalCount);
    const effectiveScore = baseScore * stackEffect.multiplier + stackEffect.additive;
    if (effectiveScore <= 0) return 0;

    let raceFactor = 1;
    if (enemyDists.length > 0) {
        const closestEnemyDist = Math.min(...enemyDists.map(d => d.get(parcelPositionKey) ?? Infinity));
        raceFactor = Math.min(1, closestEnemyDist / distancePickup);
    }

    return (effectiveScore / penalizedDistance(distancePickup, desire.target, beliefs)) * raceFactor;
}
