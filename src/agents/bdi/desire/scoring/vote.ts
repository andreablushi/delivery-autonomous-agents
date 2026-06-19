import type { Beliefs } from "../../belief/beliefs.js";
import type { RuleStore } from "../rule_store.js";
import type { HoldTileDesire } from "../../../../models/desires.js";
import { posKey } from "../../../../utils/metrics.js";
import { buildScoringContext } from "./utils.js";
import type { ScoringContext } from "../../../../models/scoring.js";
import { scoreReachDesire } from "./reach_parcel.js";
import { scoreDeliverDesire } from "./deliver_parcel.js";
import { scoreHoldTile } from "./hold_tile.js";
import { scoreReachTile } from "./reach_tile.js";
import { generateReachParcelDesires, generateDeliverDesires } from "../desire_generator.js";
import { config } from "../../../../config.js";

function bestCurrentScore(beliefs: Beliefs, ctx: ScoringContext, ruleStore: RuleStore): number {
    const { meDist, enemyDists, carriedCount, carriedValue } = ctx;
    let best = 0;

    for (const desire of generateReachParcelDesires(beliefs)) {
        best = Math.max(best, scoreReachDesire(desire, beliefs, meDist, enemyDists, ruleStore, carriedValue, carriedCount));
    }

    if (carriedCount > 0) {
        for (const desire of generateDeliverDesires(beliefs)) {
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

    const ctx = buildScoringContext(beliefs, ruleStore);
    if (!ctx) return false;

    const tiles = beliefs.map.allRendezvousTiles(ctx.me.lastPosition, x, y, max_distance);
    if (tiles.length === 0) return false;

    const decayInterval = beliefs.parcels.getSettings()?.reward_decay_interval ?? 0;
    const movementDuration = beliefs.agents.getSettings()?.movement_duration ?? 500;

    let holdScore = 0;
    for (const tile of tiles) {
        // Meeting time for this tile in steps; convert to ms for decay calc.
        const distSteps = ctx.meDist.get(posKey(tile)) ?? Infinity;
        // Include friend travel time: if the friend arrives later, carried parcels keep decaying
        // while this agent holds the zone waiting for the release condition to fire.
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
        holdScore = Math.max(holdScore, scoreHoldTile(hold, ctx.meDist, beliefs, adjustedCarriedValue));
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

    const ctx = buildScoringContext(beliefs, ruleStore);
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
        holdScore = Math.max(holdScore, scoreHoldTile(hold, ctx.meDist, beliefs, adjustedCarriedValue));
    }

    return holdScore >= bestCurrentScore(beliefs, ctx, ruleStore);
}

/**
 * Evaluate a handoff proposal on behalf of a BDI agent (this agent will become the RECEIVER).
 *
 * Returns `true` (accept) iff the meet zone is reachable (≥1 tile accessible from the agent's current position).
 */
export function evaluateHandoffVote(
    beliefs: Beliefs,
    ruleStore: RuleStore,
    rawArgs: unknown,
): boolean {
    if (typeof rawArgs !== "object" || rawArgs === null) return false;
    const obj = rawArgs as Record<string, unknown>;
    const meet_x = typeof obj.meet_x === "number" ? obj.meet_x : null;
    const meet_y = typeof obj.meet_y === "number" ? obj.meet_y : null;
    if (meet_x === null || meet_y === null) return false;

    const ctx = buildScoringContext(beliefs, ruleStore);
    if (!ctx) return false;

    const tiles = beliefs.map.allRendezvousTiles(ctx.me.lastPosition, meet_x, meet_y, config.coordination.opportunisticMeetRadius);
    return tiles.length > 0;
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

    const ctx = buildScoringContext(beliefs, ruleStore);
    if (!ctx) return false;

    const desire: import("../../../../models/desires.js").ReachTileDesire = {
        type: "REACH_TILE", target: { x: target_x, y: target_y }, sourceId: "vote", reward,
        expiresAt: Infinity,
    };
    const gotoScore = scoreReachTile(desire, ctx.meDist, beliefs, ctx.carriedValue);

    return gotoScore >= bestCurrentScore(beliefs, ctx, ruleStore);
}
