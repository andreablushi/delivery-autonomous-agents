import type { Beliefs } from "../../belief/beliefs.js";
import type { ReachTileDesire } from "../../../../models/desires.js";
import { posKey } from "../../../../utils/metrics.js";
import { penalizedDistance } from "./utils.js";

/**
 * Score a REACH_TILE desire as `(reward + carriedValue) / (distance + 1)`.
 * The `+1` keeps the score finite at distance 0 (reward) rather than Infinity, so the agent is
 * never locked onto the tile — a worthwhile parcel (same priority tier) can preempt it, and
 * regenerated positioning REACH_TILEs let the agent loiter in its zone instead of freezing.
 * The carried value is included so the score is comparable with REACH_PARCEL / DELIVER_PARCEL
 * when the agent is holding a stack.
 */
export function scoreReachTile(
    desire: ReachTileDesire,
    meDist: Map<string, number>,
    beliefs: Beliefs,
    carriedValue: number,
): number {
    const distance = meDist.get(posKey(desire.target));
    if (distance === undefined) return 0; // unreachable
    return (desire.reward + carriedValue) / (penalizedDistance(distance, desire.target, beliefs) + 1);
}
