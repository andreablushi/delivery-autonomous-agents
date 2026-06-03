import type { Position } from "../../../../models/position.js";
import type { Beliefs } from "../../belief/beliefs.js";
import type { RuleStore } from "../rule_store.js";

/** Adds the tile penalty at `target` to `distance`, making penalized targets look farther away. */
export function penalizedDistance(distance: number, target: Position, beliefs: Beliefs): number {
    return distance + beliefs.map.getTilePenalty(target);
}

/**
 * Sum the effective value of all parcels in `carried`, after parcel_value rules.
 * Used as the "opportunity cost" baseline: any action taken while holding a stack preserves
 * this value until delivery, so it is added to the numerator of non-parcel desire scores to
 * make them comparable with REACH_PARCEL / DELIVER_PARCEL on the same scale.
 */
export function carriedEffectiveValue(
    carried: { reward: number }[],
    ruleStore: RuleStore,
): number {
    return carried.reduce((sum, p) => {
        const effect = ruleStore.parcelValueEffect(p.reward);
        return sum + p.reward * effect.multiplier + effect.additive;
    }, 0);
}
