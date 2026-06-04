import type { Beliefs } from "../../belief/beliefs.js";
import type { RuleStore } from "../rule_store.js";
import type { HoldTileDesire, ReachParcelDesire, DeliverParcelDesire } from "../../../../models/desires.js";
import type { Position } from "../../../../models/position.js";
import { bfsDistancesFrom, posKey } from "../../../../utils/metrics.js";
import { MapBeliefs } from "../../belief/modules/map_beliefs.js";
import { carriedEffectiveValue } from "./utils.js";
import { scoreReachDesire } from "./reach_parcel.js";
import { scoreDeliverDesire } from "./deliver_parcel.js";
import { scoreHoldTile } from "./hold_tile.js";
import { scoreReachTile } from "./reach_tile.js";

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
 * Compute the expected total reward lost to parcel decay while standing still for `holdDurationMs`.
 * Decay is linear: each carried parcel loses 1 reward point per `decayInterval` ms.
 * Returns the reduction to apply to `carriedValue` (clamped to [0, carriedValue]).
 */
function expectedCarriedDecayLoss(
    carriedCount: number,
    holdDurationMs: number,
    decayInterval: number,
    carriedValue: number,
): number {
    if (carriedCount === 0 || decayInterval <= 0) return 0;
    const decaySteps = Math.floor(holdDurationMs / decayInterval);
    return Math.min(carriedValue, carriedCount * decaySteps);
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
 * even when the agent carries a stack. The hold's carried value is reduced by the expected
 * reward decay over the meeting time to price in points lost while waiting.
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

    const decayInterval = beliefs.parcels.getSettings()?.reward_decay_interval ?? 0;
    const movementDuration = beliefs.agents.getSettings()?.movement_duration ?? 500;

    let holdScore = 0;
    for (const tile of tiles) {
        // Meeting time for this tile in steps; convert to ms for decay calc.
        const distSteps = ctx.meDist.get(posKey(tile)) ?? Infinity;
        const friendMaxSteps = ctx.friendDists.length > 0
            ? Math.max(...ctx.friendDists.map(fd => fd.get(posKey(tile)) ?? Infinity))
            : 0;
        const meetingSteps = Math.max(distSteps, friendMaxSteps);
        const holdDurationMs = isFinite(meetingSteps) ? meetingSteps * movementDuration : 0;
        const decayLoss = expectedCarriedDecayLoss(ctx.carriedCount, holdDurationMs, decayInterval, ctx.carriedValue);
        const adjustedCarriedValue = ctx.carriedValue - decayLoss;

        const hold: HoldTileDesire = {
            type: "HOLD_TILE", target: tile, sourceId: "vote", reward,
            releaseZone: { center: { x, y }, maxDistance: max_distance },
        };
        holdScore = Math.max(holdScore, scoreHoldTile(hold, ctx.meDist, beliefs, ctx.friendDists, adjustedCarriedValue));
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
 *
 * The hold's carried value is reduced by the expected decay over the full TTL to price in
 * points lost while standing still.
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

    const decayInterval = beliefs.parcels.getSettings()?.reward_decay_interval ?? 0;
    const holdDurationMs = ttl_seconds * 1_000;
    const decayLoss = expectedCarriedDecayLoss(ctx.carriedCount, holdDurationMs, decayInterval, ctx.carriedValue);
    const adjustedCarriedValue = ctx.carriedValue - decayLoss;

    let holdScore = 0;
    for (const tile of tiles) {
        const hold: HoldTileDesire = { type: "HOLD_TILE", target: tile, sourceId: "vote", reward };
        holdScore = Math.max(holdScore, scoreHoldTile(hold, ctx.meDist, beliefs, ctx.friendDists, adjustedCarriedValue));
    }

    return holdScore >= bestCurrentScore(beliefs, ctx, ruleStore);
}

/**
 * Evaluate a handshake proposal on behalf of the DELIVER_AGENT.
 *
 * The PICKUP_AGENT (proposer) just grabbed a stack worth `carried_value` and offers to hand it
 * over at the midpoint for an extra `bonus`. We accept iff receiving the handoff is at least as
 * good as our own current best opportunity: the gain `(carried_value + bonus)` is scored as a
 * HOLD_TILE at the midpoint (meeting-time rate, accounting for both agents' travel) and compared
 * to our best REACH_PARCEL / DELIVER_PARCEL score. The whole carried stack is weighted, not a
 * single parcel.
 */
export function evaluateHandshakeVote(
    beliefs: Beliefs,
    ruleStore: RuleStore,
    rawArgs: unknown,
): boolean {
    if (typeof rawArgs !== "object" || rawArgs === null) return false;
    const obj = rawArgs as Record<string, unknown>;
    const x = typeof obj.midpoint_x === "number" ? obj.midpoint_x : null;
    const y = typeof obj.midpoint_y === "number" ? obj.midpoint_y : null;
    const max_distance = typeof obj.max_distance === "number" ? obj.max_distance : null;
    const carried_value = typeof obj.carried_value === "number" ? obj.carried_value : null;
    const bonus = typeof obj.bonus === "number" ? obj.bonus : null;
    if (x === null || y === null || max_distance === null || carried_value === null || bonus === null) return false;

    const ctx = buildVoteContext(beliefs, ruleStore);
    if (!ctx) return false;

    const tiles = beliefs.map.allRendezvousTiles(ctx.me.lastPosition, x, y, max_distance);
    if (tiles.length === 0) return false;

    const gain = carried_value + bonus;
    let holdScore = 0;
    for (const tile of tiles) {
        const hold: HoldTileDesire = {
            type: "HOLD_TILE", target: tile, sourceId: "vote", reward: gain,
            releaseZone: { center: { x, y }, maxDistance: max_distance },
        };
        holdScore = Math.max(holdScore, scoreHoldTile(hold, ctx.meDist, beliefs, ctx.friendDists, ctx.carriedValue));
    }

    return holdScore >= bestCurrentScore(beliefs, ctx, ruleStore);
}

/**
 * Evaluate a coordinator goto proposal on behalf of a BDI agent.
 *
 * Returns `true` (accept) iff the REACH_TILE score for the proposed target
 * is at least as high as the agent's current best REACH_PARCEL / DELIVER_PARCEL score.
 */
export function evaluateGotoVote(
    beliefs: Beliefs,
    ruleStore: RuleStore,
    rawArgs: unknown,
): boolean {
    if (typeof rawArgs !== "object" || rawArgs === null) return false;
    const obj = rawArgs as Record<string, unknown>;
    const target_x = typeof obj.target_x === "number" ? obj.target_x : null;
    const target_y = typeof obj.target_y === "number" ? obj.target_y : null;
    const reward   = typeof obj.reward   === "number" ? obj.reward   : null;
    if (target_x === null || target_y === null || reward === null) return false;

    const ctx = buildVoteContext(beliefs, ruleStore);
    if (!ctx) return false;

    const desire: import("../../../../models/desires.js").ReachTileDesire = {
        type: "REACH_TILE", target: { x: target_x, y: target_y }, sourceId: "vote", reward,
        expiresAt: Infinity,
    };
    const gotoScore = scoreReachTile(desire, ctx.meDist, beliefs, ctx.carriedValue);

    return gotoScore >= bestCurrentScore(beliefs, ctx, ruleStore);
}
