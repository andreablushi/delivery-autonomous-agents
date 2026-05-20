import type {
    GeneratedDesires,
    DesireType,
    ExploreDesire,
    ReachParcelDesire,
    DeliverParcelDesire,
} from "../../../models/desires.js";
import type { InjectedIntention } from "../../../models/intentions.js";
import type { Beliefs } from "../belief/beliefs.js";

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
): GeneratedDesires {
    const desires: GeneratedDesires = new Map();

    // REACH_PARCEL for each available parcel with a known position; rule/decay filtering happens in the sorter
    const reachParcel = generateReachParcelDesires(beliefs);
    if (reachParcel.length > 0) desires.set("REACH_PARCEL", reachParcel);

    // DELIVER_PARCEL for each delivery tile if the agent is carrying any parcels
    const deliverParcel = generateDeliverDesires(beliefs);
    if (deliverParcel.length > 0) desires.set("DELIVER_PARCEL", deliverParcel);

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
