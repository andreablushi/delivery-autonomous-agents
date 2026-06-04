import type { Beliefs } from "../agents/bdi/belief/beliefs.js";
import type { RuleStore } from "../agents/bdi/desire/rule_store.js";
import type { InjectedIntention } from "./intentions.js";
import type { DesireType } from "./desires.js";
import type { ScoringRule } from "./rules.js";
import type { GameStrategy } from "./game_strategy.js";
import { StrategyRole } from "./game_strategy.js";
import { PeerKind } from "./message_injection.js";
import {
    parseGotoArgs,
    parseScoringRuleArgs,
    parseTraversalPenaltyArgs,
    parseRendezvousProposeArgs,
    parseRedLightProposeArgs,
    parseAssignStrategyArgs,
} from "./injection_args.js";

export interface InjectionDeps {
    beliefs: Beliefs;
    ruleStore: RuleStore;
    addInjectedIntention: (entry: InjectedIntention) => void;
    removeIntentionsByType: (type: DesireType["type"]) => void;
    setGameStrategy: (strategy: GameStrategy) => void;
    sourceId: string;
}

/** Default HOLD_TILE reward for a DELIVER_AGENT waiting at the midpoint (committed wait). */
const DELIVER_HOLD_REWARD = 100;

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
            // The tile is the CENTER of a hold zone, not a step target — it need not be walkable
            // itself, since allRendezvousTiles (below) snaps to reachable tiles within maxDistance.
            // Only require it to be in bounds.
            if (!beliefs.map.getMap()) return { error: "Map not yet loaded" };
            if (!beliefs.map.checkMapBounds(p.tile_x, p.tile_y)) return { error: "Coordinates out of map bounds" };
            const expiresAt = Date.now() + p.ttl_seconds * 1_000;
            const center = { x: p.tile_x, y: p.tile_y };

            setGameStrategy({
                strategy: p.strategy,
                role: p.role,
                tiles: [center],
                maxDistance: p.max_distance,
                bonus: p.bonus,
                partnerId: p.partner_id,
                expiresAt,
            });

            // POSITIONING (CAMPER / MIDFIELDER) and PICKUP_AGENT inject nothing here:
            //  - POSITIONING is driven by REACH_TILE desires regenerated each cycle (desire_generator).
            //  - PICKUP_AGENT behaves normally until it grabs a parcel, then triggers the handshake.
            if (p.role !== StrategyRole.DeliverAgent) return { ok: true };

            // DELIVER_AGENT waits near the midpoint with a rendezvous-style hold that auto-releases
            // once both agents are in the zone (so it can then pick up the dropped parcel).
            const from = beliefs.agents.getCurrentPosition();
            if (!from) return { ok: true }; // strategy stored; no position yet to place a hold
            const tiles = beliefs.map.allRendezvousTiles(from, center.x, center.y, p.max_distance);
            if (tiles.length === 0) return { error: "No reachable tile within assigned zone" };
            for (const tile of tiles) {
                addInjectedIntention({
                    desire: {
                        type: "HOLD_TILE", target: tile, sourceId, reward: p.bonus ?? DELIVER_HOLD_REWARD,
                        releaseZone: { center, maxDistance: p.max_distance },
                    },
                    expiresAt,
                    sourceId,
                });
            }
            return { ok: true };
        }

        case PeerKind.RequestGoto: {
            const p = parseGotoArgs(rawArgs);
            if ("error" in p) return p;
            const errMsg = beliefs.map.validateTargetTile(p.target_x, p.target_y);
            if (errMsg) return { error: errMsg };
            const expiresAt = Date.now() + p.ttl_seconds * 1_000;
            addInjectedIntention({
                desire: { type: "REACH_TILE", target: { x: p.target_x, y: p.target_y }, sourceId, expiresAt, reward: p.reward },
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
            if (p.conditioned_axis === "stack_count") {
                rule = { id: p.id, conditioned_axis: "stack_count", registeredAt: 0,
                    predicate: { equals: p.equals, min: p.min, max: p.max }, effect };
            } else if (p.conditioned_axis === "delivery_tile") {
                if (!beliefs.map.getMap()) return { error: "Map not yet loaded" };
                if (!beliefs.map.checkMapBounds(p.tile_x!, p.tile_y!)) return { error: "Coordinates out of map bounds" };
                rule = { id: p.id, conditioned_axis: "delivery_tile", registeredAt: 0,
                    tile: { x: p.tile_x!, y: p.tile_y! }, effect };
            } else {
                rule = { id: p.id, conditioned_axis: "parcel_value", registeredAt: 0,
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
            const tiles = beliefs.map.allRendezvousTiles(from, p.x, p.y, p.max_distance);
            if (tiles.length === 0) return { error: "No reachable tile within rendezvous zone" };
            for (const tile of tiles) {
                addInjectedIntention({
                    desire: {
                        type: "HOLD_TILE",
                        target: tile,
                        sourceId,
                        reward: p.reward,
                        releaseZone: { center: { x: p.x, y: p.y }, maxDistance: p.max_distance },
                        rendezvousId: p.rid,
                    },
                    sourceId,
                });
            }
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
            for (const tile of tiles) {
                addInjectedIntention({
                    desire: { type: "HOLD_TILE", target: tile, sourceId, reward: p.reward },
                    expiresAt,
                    sourceId,
                });
            }
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
                desire: { type: "REACH_TILE", target: { x: p.target_x, y: p.target_y }, sourceId, expiresAt, reward: p.reward },
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
            return { ok: true };
        }

        default:
            return { error: `applyInjection: unknown tool "${tool}"` };
    }
}
