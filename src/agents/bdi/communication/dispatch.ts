import { tryDecode } from "../../../models/envelope.js";
import {
    parseGotoArgs,
    parseScoringRuleArgs,
    parseTraversalPenaltyArgs,
    parseRendezvousArgs,
    parseRedLightArgs,
    parseResumeArgs,
} from "../../../models/tool_args.js";
import type { Beliefs } from "../belief/beliefs.js";
import type { RuleStore } from "../belief/rule_store.js";
import type { InjectedIntention } from "../../../models/intentions.js";
import type { DesireType } from "../../../models/desires.js";
import type { ScoringRule } from "../../../models/rules.js";
import type { Logger } from "../../../utils/logger.js";

/** Returns true only if the map is loaded and (x, y) is within its bounds. */
function guardBounds(map: Beliefs["map"], x: number, y: number): boolean {
    return map.getMap() !== null && map.checkMapBounds(x, y);
}

/** Runs `parser` on `args`; logs a warning and returns null on parse failure. */
function tryParse<T extends object>(
    parser: (a: unknown) => T | { error: string },
    args: unknown,
    log: Logger,
    label: string,
): T | null {
    const result = parser(args);
    if ("error" in result) { log.warn(`bad ${label} args:`, (result as { error: string }).error); return null; }
    return result as T;
}

/**
 * Decode `content` as a peer-injection envelope and route it to the
 * appropriate handler.
 *
 * @param content   Raw message payload received from the socket.
 * @param senderId  Socket ID of the sender (already verified as a friend).
 * @param senderName Display name of the sender, used for debug logging.
 * @param beliefs   Live belief state of the receiving agent.
 * @param ruleStore Rule store the receiving agent mutates.
 * @param addInjectedIntention Callback to push a new injected intention.
 * @param log       Logger scoped to the calling Messenger.
 */
export async function dispatch(
    content: unknown,
    senderId: string,
    senderName: string,
    beliefs: Beliefs,
    ruleStore: RuleStore,
    addInjectedIntention: (entry: InjectedIntention) => void,
    removeIntentionsByType: (type: DesireType["type"]) => void,
    log: Logger,
): Promise<void> {
    // Try to decode the incoming message as a tool call envelope. If decoding fails, ignore the message.
    const envelope = tryDecode(content);
    if (!envelope) return;

    // Log the incoming injection and route to the appropriate handler based on the tool name. 
    log.debug(`injection from ${senderName} (${senderId}): ${envelope.tool}`);
    switch (envelope.tool) {

        case "request_goto": {
            const p = tryParse(parseGotoArgs, envelope.args, log, "goto");
            if (!p || !guardBounds(beliefs.map, p.target_x, p.target_y)) return;
            const expiresAt = Date.now() + p.ttl_seconds * 1_000;
            addInjectedIntention({
                desire: { type: "REACH_TILE", target: { x: p.target_x, y: p.target_y }, sourceId: senderId, expiresAt, reward: p.reward },
                expiresAt,
                sourceId: senderId,
            });
            break;
        }

        case "request_putdown_at": {
            const p = tryParse(parseGotoArgs, envelope.args, log, "putdown");
            if (!p || !guardBounds(beliefs.map, p.target_x, p.target_y)) return;
            const expiresAt = Date.now() + p.ttl_seconds * 1_000;
            addInjectedIntention({
                desire: { type: "DELIVER_PARCEL", target: { x: p.target_x, y: p.target_y }, bonus: p.reward },
                expiresAt,
                sourceId: senderId,
            });
            break;
        }

        case "register_scoring_rule": {
            const p = tryParse(parseScoringRuleArgs, envelope.args, log, "scoring rule");
            if (!p) return;
            const effect = { multiplier: p.multiplier, additive: p.additive };
            let rule: ScoringRule;
            if (p.conditioned_axis === "stack_count") {
                rule = { id: p.id, conditioned_axis: "stack_count", registeredAt: 0, predicate: { equals: p.equals, min: p.min, max: p.max }, effect };
            } else if (p.conditioned_axis === "delivery_tile") {
                if (!guardBounds(beliefs.map, p.tile_x!, p.tile_y!)) return;
                rule = { id: p.id, conditioned_axis: "delivery_tile", registeredAt: 0, tile: { x: p.tile_x!, y: p.tile_y! }, effect };
            } else {
                rule = { id: p.id, conditioned_axis: "parcel_value", registeredAt: 0, predicate: { minReward: p.min_reward, maxReward: p.max_reward }, effect };
            }
            ruleStore.upsert(rule);
            break;
        }
        
        case "register_traversal_penalty": {
            const p = tryParse(parseTraversalPenaltyArgs, envelope.args, log, "penalty");
            if (!p || !guardBounds(beliefs.map, p.target_x, p.target_y)) return;
            beliefs.map.setTilePenalty(p.id, { x: p.target_x, y: p.target_y }, p.cost);
            break;
        }

        case "request_rendezvous": {
            const p = tryParse(parseRendezvousArgs, envelope.args, log, "rendezvous");
            if (!p || !guardBounds(beliefs.map, p.x, p.y)) return;
            const from = beliefs.agents.getCurrentPosition();
            if (!from) return;
            const tiles = beliefs.map.allRendezvousTiles(from, p.x, p.y, p.max_distance);
            if (tiles.length === 0) { log.warn("request_rendezvous: no reachable tile within zone"); return; }
            for (const tile of tiles) {
                addInjectedIntention({
                    desire: {
                        type: "HOLD_TILE",
                        target: tile,
                        sourceId: senderId,
                        reward: p.reward,
                        releaseZone: { center: { x: p.x, y: p.y }, maxDistance: p.max_distance },
                    },
                    sourceId: senderId,
                });
            }
            break;
        }

        case "request_red_light": {
            const p = tryParse(parseRedLightArgs, envelope.args, log, "red_light");
            if (!p) return;
            const from = beliefs.agents.getCurrentPosition();
            if (!from) return;
            const tiles = beliefs.map.allOddRowTiles(from);
            if (tiles.length === 0) { log.warn("request_red_light: no odd-row tile reachable"); return; }
            const expiresAt = Date.now() + p.ttl_seconds * 1_000;
            for (const tile of tiles) {
                addInjectedIntention({
                    desire: { type: "HOLD_TILE", target: tile, sourceId: senderId, reward: p.reward },
                    expiresAt,
                    sourceId: senderId,
                });
            }
            break;
        }

        case "request_resume": {
            tryParse(parseResumeArgs, envelope.args, log, "resume");
            removeIntentionsByType("HOLD_TILE");
            break;
        }
        
        case "position_update": {
            const x = Number((envelope.args as { x?: unknown }).x);
            const y = Number((envelope.args as { y?: unknown }).y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            beliefs.agents.updateFriendPosition(senderId, { x, y });
            break;
        }
    }
}
