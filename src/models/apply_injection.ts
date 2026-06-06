import type { Beliefs } from "../agents/bdi/belief/beliefs.js";
import type { RuleStore } from "../agents/bdi/desire/rule_store.js";
import type { InjectedIntention } from "./intentions.js";
import type { DesireType } from "./desires.js";
import type { ScoringRule } from "./rules.js";
import { SCORING_AXIS } from "./rules.js";
import type { GameStrategy } from "./game_strategy.js";
import { PeerKind } from "./message_injection.js";
import {
    parseGotoArgs,
    parseScoringRuleArgs,
    parseTraversalPenaltyArgs,
    parseRendezvousProposeArgs,
    parseRedLightProposeArgs,
    parseAssignStrategyArgs,
} from "./injection_args.js";
import { buildRendezvousHolds, buildHolds } from "../agents/cooperation/holds.js";

export interface InjectionDeps {
    beliefs: Beliefs;
    ruleStore: RuleStore;
    addInjectedIntention: (entry: InjectedIntention) => void;
    removeIntentionsByType: (type: DesireType["type"]) => void;
    setGameStrategy: (strategy: GameStrategy) => void;
    sourceId: string;
}

export type InjectionResult = { ok: true } | { error: string };

/**
 * Parse, validate, and apply a peer-injection tool call to local BDI state.
 *
 * @param tool    The PeerInjectionKind message tool name.
 * @param rawArgs Raw arguments from the message or LLM tool call.
 * @param deps    Callbacks and references to the receiving agent's state.
 * @returns `{ ok: true }` on success, `{ error: string }` on any parse/validation failure.
 */
export function applyInjection(
    tool: string,
    rawArgs: unknown,
    deps: InjectionDeps,
): InjectionResult {
    const { beliefs, ruleStore, addInjectedIntention, removeIntentionsByType, setGameStrategy, sourceId } = deps;

    switch (tool) {

        case PeerKind.AssignStrategy: {
            const p = parseAssignStrategyArgs(rawArgs);
            if ("error" in p) return p;
            // The tile is the CENTER of a hold zone — it need not be walkable itself.
            // Only require it to be in bounds.
            if (!beliefs.map.getMap()) return { error: "Map not yet loaded" };
            if (!beliefs.map.checkMapBounds(p.tile_x, p.tile_y)) return { error: "Coordinates out of map bounds" };

            const pickupZoneCenter = (p.pickup_zone_x !== undefined && p.pickup_zone_y !== undefined)
                ? { x: p.pickup_zone_x, y: p.pickup_zone_y }
                : undefined;
            setGameStrategy({
                strategy: p.strategy,
                role: p.role,
                tiles: [{ x: p.tile_x, y: p.tile_y }],
                pickupZoneCenter,
                maxDistance: p.max_distance,
                bonus: p.bonus,
                partnerId: p.partner_id,
                expiresAt: Date.now() + p.ttl_seconds * 1_000,
            });
            // The RoleController in Intentions translates the strategy into gated desires each cycle.
            return { ok: true };
        }

        case PeerKind.RequestGoto: {
            const p = parseGotoArgs(rawArgs);
            if ("error" in p) return p;
            const errMsg = beliefs.map.validateTargetTile(p.target_x, p.target_y);
            if (errMsg) return { error: errMsg };
            const expiresAt = Date.now() + p.ttl_seconds * 1_000;
            addInjectedIntention({
                desire: { type: "PARK_TILE", target: { x: p.target_x, y: p.target_y }, sourceId, expiresAt, reward: p.reward },
                expiresAt,
                sourceId,
            });
            return { ok: true };
        }

        case PeerKind.RequestPutdownAt: {
            const p = parseGotoArgs(rawArgs);
            if ("error" in p) return p;
            const errMsg = beliefs.map.validateTargetTile(p.target_x, p.target_y);
            if (errMsg) return { error: errMsg };
            const expiresAt = Date.now() + p.ttl_seconds * 1_000;
            addInjectedIntention({
                desire: { type: "DELIVER_PARCEL", target: { x: p.target_x, y: p.target_y }, bonus: p.reward },
                expiresAt,
                sourceId,
            });
            return { ok: true };
        }

        case PeerKind.RegisterScoringRule: {
            const p = parseScoringRuleArgs(rawArgs);
            if ("error" in p) return p;
            const effect = { multiplier: p.multiplier, additive: p.additive };
            let rule: ScoringRule;
            if (p.conditioned_axis === SCORING_AXIS.STACK_COUNT) {
                rule = { id: p.id, conditioned_axis: SCORING_AXIS.STACK_COUNT, registeredAt: 0,
                    predicate: { equals: p.equals, min: p.min, max: p.max }, effect };
            } else if (p.conditioned_axis === SCORING_AXIS.DELIVERY_TILE) {
                if (!beliefs.map.getMap()) return { error: "Map not yet loaded" };
                if (!beliefs.map.checkMapBounds(p.tile_x!, p.tile_y!)) return { error: "Coordinates out of map bounds" };
                rule = { id: p.id, conditioned_axis: SCORING_AXIS.DELIVERY_TILE, registeredAt: 0,
                    tile: { x: p.tile_x!, y: p.tile_y! }, effect };
            } else {
                rule = { id: p.id, conditioned_axis: SCORING_AXIS.PARCEL_VALUE, registeredAt: 0,
                    predicate: { minReward: p.min_reward, maxReward: p.max_reward }, effect };
            }
            ruleStore.upsert(rule);
            return { ok: true };
        }

        case PeerKind.RegisterTraversalPenalty: {
            const p = parseTraversalPenaltyArgs(rawArgs);
            if ("error" in p) return p;
            if (!beliefs.map.getMap()) return { error: "Map not yet loaded" };
            if (!beliefs.map.checkMapBounds(p.target_x, p.target_y)) return { error: "Coordinates out of map bounds" };
            beliefs.map.setTilePenalty(p.id, { x: p.target_x, y: p.target_y }, p.cost);
            return { ok: true };
        }

        case PeerKind.RendezvousCommit: {
            const p = parseRendezvousProposeArgs(rawArgs);
            if ("error" in p) return p;
            if (!beliefs.map.checkMapBounds(p.x, p.y)) return { error: "Coordinates out of map bounds" };
            const from = beliefs.agents.getCurrentPosition();
            if (!from) return { error: "Agent position not yet known" };
            const holds = buildRendezvousHolds(beliefs, from, { x: p.x, y: p.y }, p.max_distance, p.reward, {
                releaseZone: { center: { x: p.x, y: p.y }, maxDistance: p.max_distance },
                rendezvousId: p.rid,
                sourceId,
            });
            if (holds.length === 0) return { error: "No reachable tile within rendezvous zone" };
            for (const hold of holds) addInjectedIntention(hold);
            return { ok: true };
        }

        case PeerKind.RendezvousAbort: {
            // No-op on the BDI side: at abort time no rendezvous_commit has been sent, so
            // no HOLD_TILE intentions from this round have been injected on any peer.
            return { ok: true };
        }

        case PeerKind.RedLightCommit: {
            const p = parseRedLightProposeArgs(rawArgs);
            if ("error" in p) return p;
            const from = beliefs.agents.getCurrentPosition();
            if (!from) return { error: "Agent position not yet known" };
            const tiles = beliefs.map.allLineTiles(from, p.axis, p.parity);
            if (tiles.length === 0) return { error: "No matching tile reachable" };
            const expiresAt = Date.now() + p.ttl_seconds * 1_000;
            const holds = buildHolds(tiles, p.reward, { sourceId, expiresAt });
            for (const hold of holds) addInjectedIntention(hold);
            return { ok: true };
        }

        case PeerKind.RedLightAbort: {
            // No-op: no holds were injected pre-commit, so there is nothing to undo.
            return { ok: true };
        }

        case PeerKind.GotoCommit: {
            const p = parseGotoArgs(rawArgs);
            if ("error" in p) return p;
            const errMsg = beliefs.map.validateTargetTile(p.target_x, p.target_y);
            if (errMsg) return { error: errMsg };
            const expiresAt = Date.now() + p.ttl_seconds * 1_000;
            addInjectedIntention({
                desire: { type: "PARK_TILE", target: { x: p.target_x, y: p.target_y }, sourceId, expiresAt, reward: p.reward },
                expiresAt,
                sourceId,
            });
            return { ok: true };
        }

        case PeerKind.GotoAbort: {
            // No holds were injected pre-commit, nothing to undo.
            return { ok: true };
        }

        case PeerKind.RequestResume: {
            // No args to validate — request_resume carries no parameters.
            removeIntentionsByType("HOLD_TILE");
            removeIntentionsByType("PARK_TILE");
            return { ok: true };
        }

        default:
            return { error: `applyInjection: unknown tool "${tool}"` };
    }
}
