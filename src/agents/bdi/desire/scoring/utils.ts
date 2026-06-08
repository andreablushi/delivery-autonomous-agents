import type { Position } from "../../../../models/position.js";
import type { Beliefs } from "../../belief/beliefs.js";
import type { RuleStore } from "../rule_store.js";
import { bfsDistancesFrom } from "../../../../utils/metrics.js";
import { MapBeliefs } from "../../belief/modules/map_beliefs.js";

/** Adds the tile penalty at `target` to `distance`, making penalized targets look farther away. */
export function penalizedDistance(distance: number, target: Position, beliefs: Beliefs): number {
    return distance + beliefs.map.getTilePenalty(target);
}

export type ScoringContext = {
    me: { id: string; lastPosition: Position };
    meDist: Map<string, number>;
    friendDists: Map<string, number>[];
    enemyDists: Map<string, number>[];
    carriedCount: number;
    carriedValue: number;
};

/**
 * Build the BFS-based scoring context shared by the desire sorter and vote evaluators.
 * Returns null when the agent's position is not yet known or the map is not loaded.
 */
export function buildScoringContext(beliefs: Beliefs, ruleStore: RuleStore): ScoringContext | null {
    const me = beliefs.agents.getCurrentMe();
    if (!me?.lastPosition) return null;

    const map = beliefs.map.getMap();
    if (!map) return null;

    const walkable = (from: Position, to: Position) =>
        MapBeliefs.isStaticWalkable(map.tiles, map.width, map.height, from, to);
    const meDist = bfsDistancesFrom(me.lastPosition, walkable);

    const friends = beliefs.agents.getCurrentFriends().filter(f => f.lastPosition !== null);
    const friendDists = friends.map(f => bfsDistancesFrom(f.lastPosition!, walkable));

    const enemies = beliefs.agents.getCurrentEnemies().filter(e => e.lastPosition !== null);
    const enemyDists = enemies.map(e => {
        const pos = { x: Math.round(e.lastPosition!.x), y: Math.round(e.lastPosition!.y) };
        return bfsDistancesFrom(pos, walkable);
    });

    const carried = beliefs.parcels.getCarriedByAgent(me.id);
    return {
        me: me as { id: string; lastPosition: Position },
        meDist,
        friendDists,
        enemyDists,
        carriedCount: carried.length,
        carriedValue: carriedEffectiveValue(carried, ruleStore),
    };
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
