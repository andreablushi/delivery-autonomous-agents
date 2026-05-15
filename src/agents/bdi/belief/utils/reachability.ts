import type { Position } from "../../../../models/position.js";
import { TILE_TYPE, type TileType } from "../../../../models/tile_type.js";
import { posKey } from "../../../../utils/metrics.js";

/**
 * Walkability rule applied directly to a tile matrix, mirroring `MapBeliefs.isWalkable`
 * but using only static tile types — no crates, no temporary blocks.
 */
function staticWalkable(matrix: TileType[][], width: number, height: number, from: Position, to: Position): boolean {
    if (to.x < 0 || to.x >= width || to.y < 0 || to.y >= height) return false;

    const type = matrix[to.y][to.x];
    if (type === TILE_TYPE.WALL) return false;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    switch (type) {
        case TILE_TYPE.CONVEYOR_LEFT:  return dx !== 1;
        case TILE_TYPE.CONVEYOR_RIGHT: return dx !== -1;
        case TILE_TYPE.CONVEYOR_UP:    return dy !== -1;
        case TILE_TYPE.CONVEYOR_DOWN:  return dy !== 1;
    }

    return true;
}

const NEIGHBOUR_DELTAS: ReadonlyArray<Position> = [
    { x:  1, y: 0 },
    { x: -1, y: 0 },
    { x: 0, y:  1 },
    { x: 0, y: -1 },
];

/**
 * Identify every tile from which at least one delivery tile is reachable in the directed
 * walkability graph defined by tile types (conveyors enforce one-way edges).
 * 
 * This allow to identify "conveyor sinks" — tiles which are not walls but from 
 * which no delivery tile can be reached.
 * @param width Map width.
 * @param height Map height.
 * @param matrix Tile type matrix.
 * @param deliveryTiles List of delivery tile positions.
 * @returns Set of `posKey(x,y)` strings for safe tiles.
 */
export function computeSafeTiles(
    width: number,
    height: number,
    matrix: TileType[][],
    deliveryTiles: Position[],
): Set<string> {
    // Accumulate safe tiles in a set of position keys for O(1) lookup;
    const safe = new Set<string>();
    if (deliveryTiles.length === 0) return safe;

    const queue: Position[] = [];
    // Set all delivery tiles as safe and add them to the queue to start a reverse BFS
    for (const delivery_tile of deliveryTiles) {
        const position_key = posKey(delivery_tile);
        if (!safe.has(position_key)) {
            safe.add(position_key);
            queue.push(delivery_tile);
        }
    }
    // While there are tiles in the queue, walk backwards along walkable edges to find all safe tiles
    while (queue.length > 0) {
        // Get the first tile from the queue and explore its neighbors
        const t = queue.shift()!;
        // For each neighbor n of t, if n can reach t and n is not already marked safe
        // mark n as safe and add it to the queue
        for (const delta of NEIGHBOUR_DELTAS) {
            const n: Position = { x: t.x + delta.x, y: t.y + delta.y };
            // Check bounds
            if (n.x < 0 || n.x >= width || n.y < 0 || n.y >= height) continue;
            const position_key = posKey(n);
            // If n is already marked safe, skip it
            if (safe.has(position_key)) continue;
            // If we cannot walk from n to t, skip n
            if (!staticWalkable(matrix, width, height, n, t)) continue;
            safe.add(position_key);
            queue.push(n);
        }
    }

    return safe;
}
