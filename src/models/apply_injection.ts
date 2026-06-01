import type { Beliefs } from "../agents/bdi/belief/beliefs.js";
import type { RuleStore } from "../agents/bdi/belief/rule_store.js";
import type { InjectedIntention } from "./intentions.js";
import type { DesireType } from "./desires.js";
import type { ScoringRule } from "./rules.js";
import { TILE_TYPE } from "./tile_type.js";
import {
    parseGotoArgs,
    parseScoringRuleArgs,
    parseTraversalPenaltyArgs,
    parseRendezvousArgs,
    parseRedLightArgs,
} from "./tool_args.js";

export interface InjectionDeps {
    beliefs: Beliefs;
    ruleStore: RuleStore;
    addInjectedIntention: (entry: InjectedIntention) => void;
    removeIntentionsByType: (type: DesireType["type"]) => void;
    sourceId: string;
}

export type InjectionResult = { ok: true } | { error: string };

/**
 * Parse, validate, and apply a peer-injection tool call to local BDI state.
 *
 * @param tool    The PeerInjectionKind envelope tool name.
 * @param rawArgs Raw arguments from the envelope or LLM tool call.
 * @param deps    Callbacks and references to the receiving agent's state.
 * @returns `{ ok: true }` on success, `{ error: string }` on any parse/validation failure.
 */
export function applyInjection(
    tool: string,
    rawArgs: unknown,
    deps: InjectionDeps,
): InjectionResult {
    const { beliefs, ruleStore, addInjectedIntention, removeIntentionsByType, sourceId } = deps;

    switch (tool) {

        case "request_goto": {
            const p = parseGotoArgs(rawArgs);
            if ("error" in p) return p;
            const map = beliefs.map.getMap();
            if (!map) return { error: "Map not yet loaded" };
            if (!beliefs.map.checkMapBounds(p.target_x, p.target_y)) return { error: "Coordinates out of map bounds" };
            if (map.tiles[p.target_y][p.target_x] === TILE_TYPE.WALL) return { error: "Target tile is a wall" };
            if (beliefs.map.isBlocked({ x: p.target_x, y: p.target_y })) return { error: "Target tile is currently blocked" };
            const expiresAt = Date.now() + p.ttl_seconds * 1_000;
            addInjectedIntention({
                desire: { type: "REACH_TILE", target: { x: p.target_x, y: p.target_y }, sourceId, expiresAt, reward: p.reward },
                expiresAt,
                sourceId,
            });
            return { ok: true };
        }

        case "request_putdown_at": {
            const p = parseGotoArgs(rawArgs);
            if ("error" in p) return p;
            const map = beliefs.map.getMap();
            if (!map) return { error: "Map not yet loaded" };
            if (!beliefs.map.checkMapBounds(p.target_x, p.target_y)) return { error: "Coordinates out of map bounds" };
            if (map.tiles[p.target_y][p.target_x] === TILE_TYPE.WALL) return { error: "Target tile is a wall" };
            if (beliefs.map.isBlocked({ x: p.target_x, y: p.target_y })) return { error: "Target tile is currently blocked" };
            const expiresAt = Date.now() + p.ttl_seconds * 1_000;
            addInjectedIntention({
                desire: { type: "DELIVER_PARCEL", target: { x: p.target_x, y: p.target_y }, bonus: p.reward },
                expiresAt,
                sourceId,
            });
            return { ok: true };
        }

        case "register_scoring_rule": {
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

        case "register_traversal_penalty": {
            const p = parseTraversalPenaltyArgs(rawArgs);
            if ("error" in p) return p;
            if (!beliefs.map.getMap()) return { error: "Map not yet loaded" };
            if (!beliefs.map.checkMapBounds(p.target_x, p.target_y)) return { error: "Coordinates out of map bounds" };
            beliefs.map.setTilePenalty(p.id, { x: p.target_x, y: p.target_y }, p.cost);
            return { ok: true };
        }

        case "request_rendezvous": {
            const p = parseRendezvousArgs(rawArgs);
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
                    },
                    sourceId,
                });
            }
            return { ok: true };
        }

        case "request_red_light": {
            const p = parseRedLightArgs(rawArgs);
            if ("error" in p) return p;
            const from = beliefs.agents.getCurrentPosition();
            if (!from) return { error: "Agent position not yet known" };
            const tiles = beliefs.map.allOddRowTiles(from);
            if (tiles.length === 0) return { error: "No odd-row tile reachable" };
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

        case "request_resume": {
            // No args to validate — request_resume carries no parameters.
            removeIntentionsByType("HOLD_TILE");
            return { ok: true };
        }

        default:
            return { error: `applyInjection: unknown tool "${tool}"` };
    }
}
