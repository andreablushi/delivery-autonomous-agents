import type { Beliefs } from "../belief/beliefs.js";
import type { RuleStore } from "./rule_store.js";
import type {
    DesireType,
    ExploreDesire,
    ReachParcelDesire,
    DeliverParcelDesire,
    ReachTileDesire,
    ParkTileDesire,
    HoldTileDesire,
    GeneratedDesires,
} from "../../../models/desires.js";
import type { Position } from "../../../models/position.js";
import { bfsDistancesFrom } from "../../../utils/metrics.js";
import { MapBeliefs } from "../belief/modules/map_beliefs.js";
import type { IntentionQueue } from "../../../models/intentions.js";
import { carriedEffectiveValue } from "./scoring/utils.js";
import { scoreReachDesire } from "./scoring/reach_parcel.js";
import { scoreDeliverDesire } from "./scoring/deliver_parcel.js";
import { scoreReachTile } from "./scoring/reach_tile.js";
import { scoreParkTile } from "./scoring/park_tile.js";
import { scoreHoldTile } from "./scoring/hold_tile.js";
import { scoreExplore } from "./scoring/explore.js";


/**
 * Build the ordered desire queue for all candidates generated this cycle.
 *
 * Priority tiers:
 *   2   — HOLD_TILE with releaseZone (committed rendezvous): non-preemptible once committed.
 *   1   — REACH_PARCEL, DELIVER_PARCEL, REACH_TILE, HOLD_TILE (red-light), and EXPLORE when a
 *         positive stack rule is active and the expected stack reward is positive.
 *   0.5 — PARK_TILE (LLM-injected station goal): settles on tile, yields to parcels, beats explore.
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
export function getIntentionQueue(
    desires: GeneratedDesires,
    beliefs: Beliefs,
    ruleStore: RuleStore,
    zone: { center: Position; maxDistance: number } | null = null,
): IntentionQueue {
    const queue: IntentionQueue = [];

    const me = beliefs.agents.getCurrentMe();
    if (!me?.lastPosition) return queue;

    const map = beliefs.map.getMap();
    if (!map) return queue;
    const walkable = (from: Position, to: Position) => MapBeliefs.isStaticWalkable(map.tiles, map.width, map.height, from, to);

    // Single BFS from agent position — reused for all desire scoring this tick
    const meDist = bfsDistancesFrom(me.lastPosition, walkable);

    // One BFS per enemy for race factor scoring (typically few enemies)
    const enemies = beliefs.agents.getCurrentEnemies().filter(e => e.lastPosition !== null);
    const enemyDists = enemies.map(e => {
        const pos = { x: Math.round(e.lastPosition!.x), y: Math.round(e.lastPosition!.y) };
        return bfsDistancesFrom(pos, walkable);
    });

    // One BFS per friend with a known position, used for joint rendezvous scoring
    const friends = beliefs.agents.getCurrentFriends().filter(f => f.lastPosition !== null);
    const friendDists = friends.map(f => bfsDistancesFrom(f.lastPosition!, walkable));

    // Carried value and count — computed once and shared across all scorers this tick
    const carried = beliefs.parcels.getCarriedByAgent(me.id);
    const carriedCount = carried.length;
    const carriedValue = carriedEffectiveValue(carried, ruleStore);

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
        queue.push({ desire, score: scoreHoldTile(desire, meDist, beliefs, friendDists, carriedValue), priority });
    }

    const parkTiles = (desires.get("PARK_TILE") ?? []) as ParkTileDesire[];
    for (const desire of parkTiles) {
        queue.push({ desire, score: scoreParkTile(desire, meDist, beliefs), priority: 0.5 });
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
