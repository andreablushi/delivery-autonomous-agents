import type { Beliefs } from "../../belief/beliefs.js";
import type { RuleStore } from "../rule_store.js";
import type { HoldTileDesire, ReachParcelDesire, DeliverParcelDesire } from "../../../../models/desires.js";
import type { Position } from "../../../../models/position.js";
import { bfsDistancesFrom } from "../../../../utils/metrics.js";
import { MapBeliefs } from "../../belief/modules/map_beliefs.js";
import { carriedEffectiveValue } from "./utils.js";
import { scoreReachDesire } from "./reach_parcel.js";
import { scoreDeliverDesire } from "./deliver_parcel.js";
import { scoreHoldTile } from "./hold_tile.js";

type VoteCtx = {
    me: { id: string; lastPosition: Position };
    meDist: Map<string, number>;
    friendDists: Map<string, number>[];
    enemyDists: Map<string, number>[];
    carriedCount: number;
    carriedValue: number;
};

function buildVoteContext(beliefs: Beliefs, ruleStore: RuleStore): VoteCtx | null {
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

function bestCurrentScore(beliefs: Beliefs, ctx: VoteCtx, ruleStore: RuleStore): number {
    const { meDist, enemyDists, carriedCount, carriedValue } = ctx;
    let best = 0;

    const parcelDesires: ReachParcelDesire[] = beliefs.parcels.getAvailableParcels()
        .filter(p => p.lastPosition !== null)
        .map(p => ({ type: "REACH_PARCEL" as const, target: p.lastPosition! }));
    for (const desire of parcelDesires) {
        best = Math.max(best, scoreReachDesire(desire, beliefs, meDist, enemyDists, ruleStore, carriedValue, carriedCount));
    }

    if (carriedCount > 0) {
        const deliveryDesires: DeliverParcelDesire[] = beliefs.map.getDeliveryTiles().map(tile => ({
            type: "DELIVER_PARCEL" as const,
            target: { x: tile.x, y: tile.y },
        }));
        for (const desire of deliveryDesires) {
            best = Math.max(best, scoreDeliverDesire(desire, beliefs, meDist, ruleStore, carriedValue, carriedCount));
        }
    }

    return best;
}

/**
 * Evaluate a rendezvous proposal on behalf of a BDI agent.
 *
 * Returns `true` (accept) iff:
 *   1. The zone is reachable (≥1 candidate tile accessible from the agent's current position), AND
 *   2. The best rendezvous rate-score across candidate tiles ≥ the agent's current best
 *      REACH_PARCEL / DELIVER_PARCEL score.
 *
 * Both sides use (value_preserved_or_gained / distance) units, so the comparison is consistent
 * even when the agent carries a stack.
 */
export function evaluateRendezvousVote(
    beliefs: Beliefs,
    ruleStore: RuleStore,
    rawArgs: unknown,
): boolean {
    if (typeof rawArgs !== "object" || rawArgs === null) return false;
    const obj = rawArgs as Record<string, unknown>;
    const x = typeof obj.x === "number" ? obj.x : null;
    const y = typeof obj.y === "number" ? obj.y : null;
    const max_distance = typeof obj.max_distance === "number" ? obj.max_distance : null;
    const reward = typeof obj.reward === "number" ? obj.reward : null;
    if (x === null || y === null || max_distance === null || reward === null) return false;

    const ctx = buildVoteContext(beliefs, ruleStore);
    if (!ctx) return false;

    const tiles = beliefs.map.allRendezvousTiles(ctx.me.lastPosition, x, y, max_distance);
    if (tiles.length === 0) return false;

    let holdScore = 0;
    for (const tile of tiles) {
        const hold: HoldTileDesire = {
            type: "HOLD_TILE", target: tile, sourceId: "vote", reward,
            releaseZone: { center: { x, y }, maxDistance: max_distance },
        };
        holdScore = Math.max(holdScore, scoreHoldTile(hold, ctx.meDist, beliefs, ctx.friendDists, ctx.carriedValue));
    }

    return holdScore >= bestCurrentScore(beliefs, ctx, ruleStore);
}

/**
 * Evaluate a red-light proposal on behalf of a BDI agent.
 *
 * Returns `true` (accept) iff:
 *   1. At least one matching tile is reachable, AND
 *   2. The best red-light rate-score across candidate tiles ≥ the agent's current best
 *      REACH_PARCEL / DELIVER_PARCEL score.
 */
export function evaluateRedLightVote(
    beliefs: Beliefs,
    ruleStore: RuleStore,
    rawArgs: unknown,
): boolean {
    if (typeof rawArgs !== "object" || rawArgs === null) return false;
    const obj = rawArgs as Record<string, unknown>;
    const reward      = typeof obj.reward === "number" ? obj.reward : null;
    const ttl_seconds = typeof obj.ttl_seconds === "number" ? obj.ttl_seconds : null;
    const axis   = (obj.axis   ?? "row")   as "row" | "column";
    const parity = (obj.parity ?? "odd")   as "odd" | "even";
    if (reward === null || ttl_seconds === null) return false;
    if (axis !== "row" && axis !== "column") return false;
    if (parity !== "odd" && parity !== "even") return false;

    const ctx = buildVoteContext(beliefs, ruleStore);
    if (!ctx) return false;

    const tiles = beliefs.map.allLineTiles(ctx.me.lastPosition, axis, parity);
    if (tiles.length === 0) return false;

    let holdScore = 0;
    for (const tile of tiles) {
        const hold: HoldTileDesire = { type: "HOLD_TILE", target: tile, sourceId: "vote", reward };
        holdScore = Math.max(holdScore, scoreHoldTile(hold, ctx.meDist, beliefs, ctx.friendDists, ctx.carriedValue));
    }

    return holdScore >= bestCurrentScore(beliefs, ctx, ruleStore);
}
