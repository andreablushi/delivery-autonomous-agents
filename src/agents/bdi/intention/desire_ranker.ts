import type { Beliefs } from "../belief/beliefs.js";
import type { RuleStore } from "../desire/rule_store.js";
import type {
    DesireType,
    ExploreDesire,
    ReachParcelDesire,
    DeliverParcelDesire,
    ReachTileDesire,
    HoldTileDesire,
    GeneratedDesires,
    DesireQueue,
} from "../../../models/desires.js";
import type { Position } from "../../../models/position.js";
import { buildScoringContext } from "../desire/scoring/utils.js";
import { scoreReachDesire } from "../desire/scoring/reach_parcel.js";
import { scoreDeliverDesire } from "../desire/scoring/deliver_parcel.js";
import { scoreReachTile } from "../desire/scoring/reach_tile.js";
import { scoreHoldTile } from "../desire/scoring/hold_tile.js";
import { scoreExplore } from "../desire/scoring/explore.js";


/**
 * Score and sort all desire candidates into the ordered desire queue.
 *
 * Priority tiers:
 *   2   — HOLD_TILE with releaseZone (committed rendezvous): non-preemptible once committed.
 *   1   — REACH_PARCEL, DELIVER_PARCEL, REACH_TILE, HOLD_TILE (red-light), and EXPLORE when a
 *         positive stack rule is active and the expected stack reward is positive.
 *   0   — EXPLORE (fallback): always yields to goal desires.
 *
 * All tier-1 scores use the same unit — (value preserved/gained) / distance — so desires
 * compete fairly even when the agent is carrying a stack.
 *
 * @param desires Grouped desires from the generator.
 * @param beliefs Current beliefs of the agent.
 * @param ruleStore Active scoring rules; applied when scoring REACH_PARCEL, DELIVER_PARCEL, and EXPLORE.
 * @returns The ordered desire queue, or an empty array if no candidates are available.
 */
export function rankDesires(
    desires: GeneratedDesires,
    beliefs: Beliefs,
    ruleStore: RuleStore,
    zone: { center: Position; maxDistance: number } | null = null,
    currentHoldTarget?: Position,
): DesireQueue {
    const queue: DesireQueue = [];

    const ctx = buildScoringContext(beliefs, ruleStore);
    if (!ctx) return queue;

    const { meDist, enemyDists, carriedCount, carriedValue } = ctx;

    const reaches = (desires.get("REACH_PARCEL") ?? []) as ReachParcelDesire[];
    const delivers = (desires.get("DELIVER_PARCEL") ?? []) as DeliverParcelDesire[];

    for (const desire of reaches) {
        queue.push({ desire, score: scoreReachDesire(desire, beliefs, meDist, enemyDists, ruleStore, carriedValue, carriedCount, zone), priority: 1 });
    }
    for (const desire of delivers) {
        queue.push({ desire, score: scoreDeliverDesire(desire, beliefs, meDist, ruleStore, carriedValue, carriedCount), priority: 1 });
    }

    const reachTiles = (desires.get("REACH_TILE") ?? []) as ReachTileDesire[];
    for (const desire of reachTiles) {
        queue.push({ desire, score: scoreReachTile(desire, meDist, beliefs, carriedValue), priority: 1 });
    }

    const holdTiles = (desires.get("HOLD_TILE") ?? []) as HoldTileDesire[];
    for (const desire of holdTiles) {
        // Committed rendezvous holds (releaseZone present) get tier 2 so they cannot be
        // preempted by parcels once committed; red-light holds (no releaseZone) stay tier 1.
        const priority = desire.releaseZone ? 2 : 1;
        queue.push({ desire, score: scoreHoldTile(desire, meDist, beliefs, carriedValue, currentHoldTarget), priority });
    }

    const explores = (desires.get("EXPLORE") ?? []) as ExploreDesire[];
    const now = Date.now();
    const hasPositiveStack = ruleStore.hasPositiveStackRule();
    for (const desire of explores) {
        const { score, priority } = scoreExplore(desire, meDist, beliefs, ruleStore, now, hasPositiveStack);
        queue.push({ desire, score, priority });
    }

    // Sort by priority tier first, then by score within the same tier
    return queue.sort((a, b) => b.priority - a.priority || b.score - a.score);
}
