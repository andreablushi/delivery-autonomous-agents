import type { Beliefs } from "../bdi/belief/beliefs.js";
import type { Position } from "../../models/position.js";
import { posKey } from "../../utils/metrics.js";

/** Exchange tile plus distinct adjacent wait cells for each side of the handoff. */
export type HandoffGeometry = {
    meetTile: Position;
    carrierApproach: Position;
    receiverApproach: Position;
};

/**
 * Find an exchange tile M and distinct adjacent wait cells for the carrier and receiver.
 *
 * Searches tiles reachable from `carrierPos` within `radius` of `center`. For each
 * candidate M, picks the nearest neighbor of M (by BFS from each agent) as their approach
 * cell — the cell they wait on before the carrier steps onto M to drop.
 *
 * @returns { meetTile, carrierApproach, receiverApproach } or null if no valid geometry found.
 */
export function computeHandoffGeometry(
    beliefs: Beliefs,
    carrierPos: Position,
    partnerPos: Position,
    center: Position,
    radius: number,
): HandoffGeometry | null {
    const candidates = beliefs.map.allRendezvousTiles(carrierPos, center.x, center.y, radius);
    for (const M of candidates) {
        const pair = findApproachPair(beliefs, carrierPos, partnerPos, M);
        if (pair) return { meetTile: M, ...pair };
    }
    return null;
}

/**
 * Given a known exchange tile M, find distinct adjacent wait cells for the carrier and receiver.
 * Returns null if M has fewer than two distinct reachable neighbors (one per agent).
 */
export function findApproachPair(
    beliefs: Beliefs,
    carrierPos: Position,
    partnerPos: Position,
    M: Position,
): { carrierApproach: Position; receiverApproach: Position } | null {
    const mKey = posKey(M);
    // Neighbors of M reachable from each agent, sorted by travel distance from that agent.
    const carrierNeighbors = beliefs.map.allRendezvousTiles(carrierPos, M.x, M.y, 1)
        .filter(t => posKey(t) !== mKey);
    const receiverNeighbors = beliefs.map.allRendezvousTiles(partnerPos, M.x, M.y, 1)
        .filter(t => posKey(t) !== mKey);
    if (carrierNeighbors.length === 0 || receiverNeighbors.length === 0) return null;
    const carrierApproach = carrierNeighbors[0]!;
    const carrierKey = posKey(carrierApproach);
    // Receiver gets the nearest neighbor that is not already claimed by the carrier.
    const receiverApproach = receiverNeighbors.find(t => posKey(t) !== carrierKey);
    if (!receiverApproach) return null;
    return { carrierApproach, receiverApproach };
}
