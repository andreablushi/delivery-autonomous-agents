import type { Beliefs } from "../../belief/beliefs.js";
import type { HoldTileDesire } from "../../../../models/desires.js";
import type { Position } from "../../../../models/position.js";
import { posKey } from "../../../../utils/metrics.js";
import { penalizedDistance } from "./utils.js";
import { config } from "../../../../config.js";

/**
 * Score a HOLD_TILE desire: `(reward + carriedValue) / penalizedDistance`.
 * Returns Infinity when already at the target so the hold anchors the agent there.
 *
 * For rendezvous holds the release fires when all agents are anywhere within the zone boundary,
 * so each agent simply navigates to their nearest reachable tile in the zone independently.
 *
 * The carried value is included so the score is comparable with REACH_PARCEL / DELIVER_PARCEL
 * when the agent is holding a stack.
 */
export function scoreHoldTile(
    desire: HoldTileDesire,
    meDist: Map<string, number>,
    beliefs: Beliefs,
    carriedValue: number,
    currentHoldTarget?: Position,
): number {
    const distance = meDist.get(posKey(desire.target));
    if (distance === undefined) return 0; // unreachable
    if (distance === 0) return Infinity;
    // Add the carried value to the desire reward to get an effective reward that can be compared with REACH_PARCEL / DELIVER_PARCEL desires
    const effectiveReward = desire.reward + carriedValue;
    
    const key = posKey(desire.target);
    const base = effectiveReward / penalizedDistance(distance, desire.target, beliefs);
    const isIncumbent = currentHoldTarget !== undefined && key === posKey(currentHoldTarget);    
    return isIncumbent ? base * (1 + config.rendezvous.stickinessMargin) : base;
}
