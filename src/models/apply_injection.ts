import type { Beliefs } from "../agents/bdi/belief/beliefs.js";
import type { RuleStore } from "../agents/bdi/desire/rule_store.js";
import type { InjectedDesire } from "./desires.js";
import type { DesireType } from "./desires.js";
import type { ScoringRule } from "./rules.js";
import { SCORING_AXIS } from "./rules.js";
import type { GameStrategy } from "./game_strategy.js";
import { PeerKind } from "./message_injection.js";
import { StrategyType, StrategyRole } from "./game_strategy.js";
import { config } from "../config.js";
import {
    parseGotoArgs,
    parseScoringRuleArgs,
    parseTraversalPenaltyArgs,
    parseRendezvousProposeArgs,
    parseRedLightProposeArgs,
    parseAssignStrategyArgs,
    parseHandpassProposeArgs,
} from "./injection_args.js";
import { buildRendezvousHolds, buildHolds } from "../agents/cooperation/holds.js";

export interface InjectionDeps {
    beliefs: Beliefs;
    ruleStore: RuleStore;
    addInjectedDesire: (entry: InjectedDesire) => void;
    removeInjectedDesiresByType: (type: DesireType["type"]) => void;
    setGameStrategy: (strategy: GameStrategy) => void;
    sourceId: string;
    armHandpass?: (bonus: number | undefined, ttlMs: number) => void;
    disarmHandpass?: () => void;
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
    const { beliefs, ruleStore, addInjectedDesire, removeInjectedDesiresByType, setGameStrategy, sourceId } = deps;

    switch (tool) {

        case PeerKind.AssignStrategy: {
            const p = parseAssignStrategyArgs(rawArgs);
            if ("error" in p) return p;
            if (!beliefs.map.getMap()) return { error: "Map not yet loaded" };
            if (!beliefs.map.checkMapBounds(p.tile_x, p.tile_y)) return { error: "Coordinates out of map bounds" };

            const approachTile = (p.approach_x !== undefined && p.approach_y !== undefined)
                ? { x: p.approach_x, y: p.approach_y }
                : undefined;
            setGameStrategy({
                strategy: p.strategy,
                role: p.role,
                tiles: [{ x: p.tile_x, y: p.tile_y }],
                approachTile,
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
            addInjectedDesire({
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
            addInjectedDesire({
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
                rendezvousId: p.roundId,
                sourceId,
            });
            if (holds.length === 0) return { error: "No reachable tile within rendezvous zone" };
            for (const hold of holds) addInjectedDesire(hold);
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
            for (const hold of holds) addInjectedDesire(hold);
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
            addInjectedDesire({
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
            removeInjectedDesiresByType("HOLD_TILE");
            removeInjectedDesiresByType("PARK_TILE");
            return { ok: true };
        }

        case PeerKind.HandpassCommit: {
            const p = parseHandpassProposeArgs(rawArgs);
            if ("error" in p) return p;
            if (!beliefs.map.checkMapBounds(p.meet_x, p.meet_y)) return { error: "Coordinates out of map bounds" };
            const approachTile = (p.approach_x !== undefined && p.approach_y !== undefined)
                ? { x: p.approach_x, y: p.approach_y }
                : undefined;
            setGameStrategy({
                strategy: StrategyType.Opportunistic,
                role: StrategyRole.Receiver,
                tiles: [{ x: p.meet_x, y: p.meet_y }],
                approachTile,
                maxDistance: config.handoff.zoneRadius,
                partnerId: sourceId,
                expiresAt: Date.now() + p.ttl_seconds * 1_000,
            });
            deps.disarmHandpass?.();
            return { ok: true };
        }

        case PeerKind.HandpassAbort:
            // No-op: no state was injected pre-commit, nothing to undo.
            return { ok: true };

        case PeerKind.SetHandpassMode: {
            const args = rawArgs as Record<string, unknown>;
            if (args.armed === true) {
                const bonus = typeof args.bonus === "number" ? args.bonus : undefined;
                const ttl_seconds = typeof args.ttl_seconds === "number" ? args.ttl_seconds : 120;
                deps.armHandpass?.(bonus, ttl_seconds * 1_000);
            } else {
                deps.disarmHandpass?.();
            }
            return { ok: true };
        }

        default:
            return { error: `applyInjection: unknown tool "${tool}"` };
    }
}
