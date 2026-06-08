import type { Position } from "../../../../models/position.js";
import type { ReachTileDesire } from "../../../../models/desires.js";

/** Single-tile REACH_TILE desire for navigating to an approach cell and waiting there. */
export function approachDesire(tile: Position): ReachTileDesire {
    return {
        type: "REACH_TILE",
        target: tile,
        sourceId: "role",
        reward: 100,
        expiresAt: Infinity,
    };
}
