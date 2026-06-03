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
    if (carriedCount === 0) return 0;

    const distance = meDist.get(posKey(desire.target));
    if (distance === undefined) return 0; // unreachable
    if (distance === 0) return Infinity;

    const stackEffect = ruleStore.stackCountEffect(carriedCount);
    const tileEffect = ruleStore.deliveryTileEffect(desire.target);
    const effectiveScore = carriedValue * stackEffect.multiplier * tileEffect.multiplier
        + stackEffect.additive + tileEffect.additive
        + (desire.bonus ?? 0);
    if (effectiveScore <= 0) return 0;

    return effectiveScore / penalizedDistance(distance, desire.target, beliefs);
}
