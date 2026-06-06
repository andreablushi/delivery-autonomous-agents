import type { Beliefs } from "../../belief/beliefs.js";
import type { RuleStore } from "../rule_store.js";
import type { DeliverParcelDesire } from "../../../../models/desires.js";
import { posKey } from "../../../../utils/metrics.js";
import { penalizedDistance } from "./utils.js";

/**
 * Score a DELIVER_PARCEL desire applying stack_count, delivery_tile, and parcel_value rules.
 * Falls back to 0 when nothing is carried, the target is unreachable, or effective score ≤ 0.
 */
export function scoreDeliverDesire(
    desire: DeliverParcelDesire,
    beliefs: Beliefs,
    meDist: Map<string, number>,
    ruleStore: RuleStore,
    carriedValue: number,
    carriedCount: number,
): number {
    // No parcel being carried -> reward 0
    if (carriedCount === 0) return 0;

    const distance = meDist.get(posKey(desire.target));
    if (distance === undefined) return 0; // unreachable
    // If we are already on the delivery tile, we MUST deliver immediately
    if (distance === 0) return Infinity;

    // Retrieve rule effects
    const stackEffect = ruleStore.stackCountEffect(carriedCount);
    const tileEffect = ruleStore.deliveryTileEffect(desire.target);
    const parcelEffect = ruleStore.parcelValueEffect(carriedValue);

    const effectiveScore = carriedValue * stackEffect.multiplier * tileEffect.multiplier * parcelEffect.multiplier
        + stackEffect.additive + tileEffect.additive + parcelEffect.additive
        + (desire.bonus ?? 0);
    if (effectiveScore <= 0) return 0;

    return effectiveScore / penalizedDistance(distance, desire.target, beliefs);
}
