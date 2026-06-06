import type { Beliefs } from "../../belief/beliefs.js";
import type { HoldTileDesire } from "../../../../models/desires.js";
import type { Position } from "../../../../models/position.js";
import { posKey } from "../../../../utils/metrics.js";
import { penalizedDistance } from "./utils.js";
import { config } from "../../../../config.js";

/**
 * Score a HOLD_TILE desire.
 *
 * Red-light holds (no releaseZone): `(reward + carriedValue) / penalizedDistance`.
 * Returns Infinity when already at the target so the hold anchors the agent there.
 *
 * Rendezvous holds (releaseZone present): `(reward + carriedValue) / max(distSelf, maxFriendDist)` —
 * the effective meeting time is the bottleneck across all agents. Both agents evaluate the same
 * formula independently, so they converge on the joint-optimal tile. Tiles unreachable by
 * any friend score 0 so the agent never waits at a spot a friend cannot reach.
 * Falls back to individual scoring when no friend positions are known.
 *
 * The carried value is included so the score is comparable with REACH_PARCEL / DELIVER_PARCEL
 * when the agent is holding a stack.
 */
export function scoreHoldTile(
    desire: HoldTileDesire,
    meDist: Map<string, number>,
    beliefs: Beliefs,
    friendDists: Map<string, number>[],
    carriedValue: number,
    currentHoldTarget?: Position,
): number {
    const distance = meDist.get(posKey(desire.target));
    if (distance === undefined) return 0; // unreachable
    if (distance === 0) return Infinity;

    const effectiveReward = desire.reward + carriedValue;

    if (desire.releaseZone && friendDists.length > 0) {
        const key = posKey(desire.target);
        const maxFriendDist = Math.max(...friendDists.map(fd => fd.get(key) ?? Infinity));
        const meetingTime = Math.max(distance, maxFriendDist);
        if (!isFinite(meetingTime)) return 0; // a friend cannot reach this tile
        const base = effectiveReward / meetingTime;
        // Give the incumbent hold tile a small bonus so the argmax only flips when a rival is
        // meaningfully better — kills per-tick target oscillation as maxFriendDist jitters.
        const isIncumbent = currentHoldTarget !== undefined && key === posKey(currentHoldTarget);
        return isIncumbent ? base * (1 + config.rendezvous.stickinessMargin) : base;
    }

    return effectiveReward / penalizedDistance(distance, desire.target, beliefs);
}
