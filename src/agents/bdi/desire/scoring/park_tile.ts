import type { Beliefs } from "../../belief/beliefs.js";
import type { ParkTileDesire } from "../../../../models/desires.js";
import { posKey } from "../../../../utils/metrics.js";
import { penalizedDistance } from "./utils.js";

/**
 * Score a PARK_TILE desire as `reward / (distance + 1)`.
 *
 * Intentionally excludes the carried-value term used by REACH_TILE / REACH_PARCEL / DELIVER_PARCEL,
 * so a park goal always yields to delivering a carried stack: even a tiny DELIVER_PARCEL score
 * (reward ≪ carried) will outrank a distant park tile.
 * The `+1` keeps the score finite at distance 0, consistent with the other scorers.
 */
export function scoreParkTile(
    desire: ParkTileDesire,
    meDist: Map<string, number>,
    beliefs: Beliefs,
): number {
    const distance = meDist.get(posKey(desire.target));
    if (distance === undefined) return 0; // unreachable
    return desire.reward / (penalizedDistance(distance, desire.target, beliefs) + 1);
}
