import { pathIgnoring, pathThroughPushableCrates } from "../../plan/navigation/a_star.js";
import { posKey } from "../../../../utils/metrics.js";
import type { Beliefs } from "../beliefs.js";
import type { Position } from "../../../../models/position.js";
import type { NavigationDesire } from "../../../../models/desires.js";

/**
 * Check whether any currently believed crate blocks the direct path from `from` to `desire.target`.
 * If so, return the IDs of all crates that would be traversed on the crate-ignoring path.
 * @param beliefs Current agent beliefs.
 * @param from Agent's current position.
 * @param desire The navigation desire whose target we are trying to reach.
 * @returns An array of blocking crate IDs, or null if the path is clear or no crate-ignoring path exists.
 */
export function detectCrateBlock(
    beliefs: Beliefs,
    from: Position,
    desire: NavigationDesire,
): string[] | null {
    const crates = beliefs.map.getCurrentCrates().flatMap(c =>
        c.lastPosition ? [{ id: c.id, position: c.lastPosition }] : [],
    );
    if (crates.length === 0) return null;

    const crateKeys = new Set(crates.map(c => posKey(c.position)));
    const path = pathIgnoring(beliefs, from, desire.target, crateKeys);
    if (!path) return null;

    const crateIds = crates.filter(c => crateKeys.has(posKey(c.position))).map(c => c.id);
    return crateIds.length > 0 ? crateIds : null;
}

/**
 * Find the contiguous crate-blocked segment on the push-aware path from `from` to `target`.
 * Uses `pathThroughPushableCrates` so it only routes through crates that are single-step
 * pushable in the direction of travel — immovable crates are treated as walls, causing the
 * search to naturally select an alternative path that can actually be cleared.
 *
 * @returns An object containing:
 * - `entry`: the position just before the first crate tile (or `from` if path starts on a crate)
 * - `exit`: the position just after the last crate tile (or `target` if path ends on a crate)
 * - `clusterCrates`: an array of all crates within the bounding box of entry+exit+on-path crate tiles, padded by 1
 *
 */
export function findCrateSegment(
    beliefs: Beliefs,
    from: Position,
    target: Position,
): { entry: Position; exit: Position; clusterCrates: { id: string; position: Position }[] } | null {
    const crates = beliefs.map.getCurrentCrates().flatMap(c =>
        c.lastPosition ? [{ id: c.id, position: c.lastPosition }] : [],
    );
    if (crates.length === 0) return null;

    // Push-aware path: only routes through crates whose push destination is a free crate-space.
    // Immovable crates (wall behind them in travel direction) are treated as walls.
    const path = pathThroughPushableCrates(beliefs, from, target);
    if (!path) return null;

    // Find the first (ENTRY) and last (EXIT) indices where the path crosses a crate tile
    let firstIdx = -1;
    let lastIdx = -1;
    for (let i = 0; i < path.length; i++) {
        if (beliefs.map.isCrateAt(path[i])) {
            if (firstIdx === -1) firstIdx = i;
            lastIdx = i;
        }
    }
    if (firstIdx === -1) return null; // push-aware path avoided all crates — not actually blocked

    // Entry: tile just before the first crate tile (or `from` if path starts on a crate)
    const entry: Position = firstIdx === 0 ? from : path[firstIdx - 1];
    // Exit: tile just after the last crate tile (or `target` if path ends on a crate)
    const exit: Position = lastIdx === path.length - 1 ? target : path[lastIdx + 1];

    // Cluster cache key: all crates within the bounding box of entry+exit+on-path crate tiles, padded by 1
    const keyTiles: Position[] = [entry, exit];
    for (let i = firstIdx; i <= lastIdx; i++) {
        if (beliefs.map.isCrateAt(path[i])) keyTiles.push(path[i]);
    }
    const size = beliefs.map.getMapSize();
    const minX = Math.max(0, Math.min(...keyTiles.map(p => p.x)) - 1);
    const minY = Math.max(0, Math.min(...keyTiles.map(p => p.y)) - 1);
    const maxX = size ? Math.min(size.width - 1, Math.max(...keyTiles.map(p => p.x)) + 1) : Math.max(...keyTiles.map(p => p.x)) + 1;
    const maxY = size ? Math.min(size.height - 1, Math.max(...keyTiles.map(p => p.y)) + 1) : Math.max(...keyTiles.map(p => p.y)) + 1;

    const clusterCrates = crates.filter(c =>
        c.position.x >= minX && c.position.x <= maxX &&
        c.position.y >= minY && c.position.y <= maxY,
    );

    return { entry, exit, clusterCrates };
}

/**
 * Check whether at least one believed crate still lies on the path from `from` to `target`.
 * Used to verify whether a crate-blocked route is still obstructed after a belief update.
 * @param beliefs Current agent beliefs.
 * @param from Agent's current position.
 * @param target The target position the agent wants to reach.
 * @returns true if a crate is still on the path, false otherwise.
 */
export function hasCrateOnPath(
    beliefs: Beliefs,
    from: Position,
    target: Position,
): boolean {
    const crates = beliefs.map.getCurrentCrates().flatMap(c =>
        c.lastPosition ? [{ position: c.lastPosition }] : [],
    );
    if (crates.length === 0) return false;

    const crateKeys = new Set(crates.map(c => posKey(c.position)));
    const path = pathIgnoring(beliefs, from, target, crateKeys);
    return !!path && path.some(pos => crateKeys.has(posKey(pos)));
}
