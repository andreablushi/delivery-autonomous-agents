import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { ReachTileDesire } from "../../../models/desires.js";

export function meetZoneTiles(
    beliefs: Beliefs,
    from: { x: number; y: number },
    center: { x: number; y: number },
    maxDistance: number,
): ReachTileDesire[] {
    const tiles = beliefs.map.allRendezvousTiles(from, center.x, center.y, maxDistance);
    return tiles.map(t => ({
        type: "REACH_TILE" as const,
        target: t,
        sourceId: "role",
        reward: 100,
        expiresAt: Infinity,
    }));
}
