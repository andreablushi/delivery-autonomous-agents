import type { Position } from "./position.js";

/**
 * BFS-based context shared by the desire ranker and the vote evaluators.
 * Built once per deliberation tick by `buildScoringContext`.
 */
export type ScoringContext = {
    me: { id: string; lastPosition: Position };
    meDist: Map<string, number>;        // BFS step-distances from self to every reachable tile
    friendDists: Map<string, number>[]; // same, per known friend
    enemyDists: Map<string, number>[];  // same, per known enemy
    carriedCount: number;               // number of parcels currently carried
    carriedValue: number;               // effective value of carried parcels (after rules)
};
