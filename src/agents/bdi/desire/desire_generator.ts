import type {
    GeneratedDesires,
    DesireType,
    ExploreDesire,
    ReachParcelDesire,
    DeliverParcelDesire,
    ReachTileDesire,
} from "../../../models/desires.js";
import type { InjectedIntention } from "../../../models/intentions.js";
import type { GameStrategy } from "../../../models/game_strategy.js";
import { StrategyType } from "../../../models/game_strategy.js";
import { TILE_TYPE } from "../../../models/tile_type.js";
import type { Beliefs } from "../belief/beliefs.js";

/** Default reward for a positioning REACH_TILE (modest, so worthwhile parcels still preempt it). */
const POSITIONING_REWARD = 10;

/**
    * Generates desires based on the current beliefs and injected intentions.
    * - For each available parcel with a known position, generate a REACH_PARCEL desire.
    * - If the agent is carrying any parcels, generate a DELIVER_PARCEL desire for each delivery tile.
    * - Generate an EXPLORE desire for each spawn tile.
    * - Injected intentions (from LLM, peer agents) are merged into the appropriate type bucket.
    * Rule-based filtering and decay projection happen in the sorter, which has BFS distance info.
    * Note: crate-clearing is handled transparently by the Planner as a fallback when A* fails.
    * @param beliefs Current beliefs of the agent.
    * @param injectedIntentions Live injected intentions to merge into the generated desires.
    * @returns A map of desire types to arrays of generated desires.
 */
export function generateDesires(
    beliefs: Beliefs,
    injectedIntentions: readonly InjectedIntention[],
    strategy: GameStrategy | null = null,
): GeneratedDesires {
    const desires: GeneratedDesires = new Map();

    // REACH_PARCEL for each available parcel with a known position; rule/decay filtering happens in the sorter
    const reachParcel = generateReachParcelDesires(beliefs);
    if (reachParcel.length > 0) desires.set("REACH_PARCEL", reachParcel);

    // DELIVER_PARCEL for each delivery tile if the agent is carrying any parcels
    const deliverParcel = generateDeliverDesires(beliefs);
    if (deliverParcel.length > 0) desires.set("DELIVER_PARCEL", deliverParcel);

    // REACH_TILE over the assigned zone for a POSITIONING strategy (regenerated every cycle, never
    // injected — so it needs no cleanup and re-pulls the agent back if it drifts).
    const positioning = generatePositioningDesires(beliefs, strategy);
    if (positioning.length > 0) desires.set("REACH_TILE", positioning);

    // EXPLORE desire for each spawn tile as a fallback when no parcels are available
    const explore = generateExploreDesires(beliefs);
    if (explore.length > 0) desires.set("EXPLORE", explore);

    // Merge injected intentions (LLM / peer goals) into the appropriate type bucket
    for (const entry of injectedIntentions) {
        const bucket = (desires.get(entry.desire.type) ?? []) as DesireType[];
        bucket.push(entry.desire);
        desires.set(entry.desire.type, bucket);
    }

    return desires;
}

/**
 * Generate a REACH_TILE for each in-bounds, non-wall tile within manhattan `maxDistance` of the
 * POSITIONING strategy's assigned center. A range (not a single tile) so the agent loiters within
 * its zone instead of ping-ponging one edge; the sorter scores reachable tiles and ignores the rest.
 * @param beliefs Current beliefs (map for bounds/wall checks).
 * @param strategy The active GameStrategy, or null.
 * @returns REACH_TILE desires for the zone, or [] when no POSITIONING strategy is active.
 */
function generatePositioningDesires(beliefs: Beliefs, strategy: GameStrategy | null): ReachTileDesire[] {
    if (!strategy || strategy.strategy !== StrategyType.Positioning) return [];
    const center = strategy.tiles[0];
    if (!center) return [];
    const map = beliefs.map.getMap();
    if (!map) return [];

    const maxDistance = strategy.maxDistance ?? 1;
    const reward = strategy.bonus ?? POSITIONING_REWARD;
    const desires: ReachTileDesire[] = [];
    for (let dy = -maxDistance; dy <= maxDistance; dy++) {
        for (let dx = -maxDistance; dx <= maxDistance; dx++) {
            if (Math.abs(dx) + Math.abs(dy) > maxDistance) continue;
            const x = center.x + dx;
            const y = center.y + dy;
            if (!beliefs.map.checkMapBounds(x, y)) continue;
            if (map.tiles[y][x] === TILE_TYPE.WALL) continue;
            desires.push({ type: "REACH_TILE", target: { x, y }, sourceId: "strategy", reward, expiresAt: Infinity });
        }
    }
    return desires;
}

/**
 * Generate REACH_PARCEL desires for each available parcel with a known position.
 * Rule-based and decay-based filtering is deferred to the sorter, which has BFS distance info.
 * @param beliefs Current beliefs of the agent.
 * @returns An array of REACH_PARCEL desires, each targeting the last known position of an available parcel.
 */
function generateReachParcelDesires(beliefs: Beliefs): ReachParcelDesire[] {
    return beliefs.parcels.getAvailableParcels()
        .filter(parcel => parcel.lastPosition !== null)
        .map(parcel => ({
            type: "REACH_PARCEL" as const,
            target: { x: parcel.lastPosition!.x, y: parcel.lastPosition!.y },
        }));
}

/**
 * Generate DELIVER_PARCEL desires for each delivery tile if the agent is carrying any parcels.
 * @param beliefs Current beliefs of the agent, used to determine if the agent is carrying parcels and to get delivery tile positions.
 * @returns An array of DELIVER_PARCEL desires, each targeting a delivery tile position, or an empty array if the agent is not carrying any parcels.
 */
function generateDeliverDesires(beliefs: Beliefs): DeliverParcelDesire[] {
    const me = beliefs.agents.getCurrentMe();
    if (!me) return [];
    if (beliefs.parcels.getCarriedByAgent(me.id).length === 0) return [];

    return beliefs.map.getDeliveryTiles().map(tile => ({
        type: "DELIVER_PARCEL" as const,
        target: { x: tile.x, y: tile.y },
    }));
}

/**
 * Generate EXPLORE desires for each spawn tile as a fallback when no parcels are available.
 * @param beliefs Current beliefs of the agent, used to get spawn tile positions.
 * @returns An array of EXPLORE desires, each targeting a spawn tile position.
 */
function generateExploreDesires(beliefs: Beliefs): ExploreDesire[] {
    return beliefs.map.getSpawnTiles().map(tile => ({
            type: "EXPLORE" as const,
            target: { x: tile.x, y: tile.y },
        }));
}
