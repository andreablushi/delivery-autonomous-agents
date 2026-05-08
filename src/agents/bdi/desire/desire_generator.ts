import type {
    GeneratedDesires,
    ExploreDesire,
    ReachParcelDesire,
    DeliverParcelDesire,
} from "../../../models/desires.js";
import type { Beliefs } from "../belief/beliefs.js";
import { manhattanDistance } from "../../../utils/metrics.js";

/**
    * Generates desires based on the current beliefs of the agent.
    * The desires are generated according to the following rules:
    * - For each available parcel with a known position, generate a REACH_PARCEL desire targeting that position.
    * - If the agent is carrying any parcels, generate a DELIVER_PARCEL desire for each delivery tile, targeting the tile's position.
    * - If there are no available parcels, generate an EXPLORE desire for each spawn tile, targeting the tile's position.
    * Note: CLEAR_CRATE desires are tracked in Intentions and injected into the queue via intentions.update().
    * @param beliefs Current beliefs of the agent, used to determine available parcels, carried parcels, and tile positions.
    * @returns A map of desire types to arrays of generated desires, which may be empty if no desires of that type are applicable.
 */
export function generateDesires(beliefs: Beliefs): GeneratedDesires {
    const desires: GeneratedDesires = new Map();

    // REACH_PARCEL for each available parcel with a known position
    const reachParcel = generateReachParcelDesires(beliefs);
    if (reachParcel.length > 0) desires.set("REACH_PARCEL", reachParcel);

    // DELIVER_PARCEL for each delivery tile if the agent is carrying any parcels
    const deliverParcel = generateDeliverDesires(beliefs);
    if (deliverParcel.length > 0) desires.set("DELIVER_PARCEL", deliverParcel);

    // EXPLORE desire for each spawn tile as a fallback when no parcels are available
    const explore = generateExploreDesires(beliefs);
    if (explore.length > 0) desires.set("EXPLORE", explore);

    return desires;
}

/**
 * Generate REACH_PARCEL desires for each available parcel with a known position.
 * @param beliefs Current beliefs of the agent, used to determine available parcels and their positions.
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
 * Excluded the spawn tiles in my observation range
 * @param beliefs Current beliefs of the agent, used to get spawn tile positions.
 * @returns An array of EXPLORE desires, each targeting a spawn tile position.
 */
function generateExploreDesires(beliefs: Beliefs): ExploreDesire[] {
    const me = beliefs.agents.getCurrentMe();
    const observationDistance = beliefs.agents.getObservationDistance();

    return beliefs.map.getSpawnTiles()
        .filter(tile => {
            if (!me?.lastPosition || observationDistance === null) return true;
            return manhattanDistance(me.lastPosition, tile) > observationDistance;
        })
        .map(tile => ({
            type: "EXPLORE" as const,
            target: { x: tile.x, y: tile.y },
        }));
}
