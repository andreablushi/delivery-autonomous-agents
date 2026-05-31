import type { Beliefs } from "../../belief/beliefs.js";
import type { Position } from "../../../../models/position.js";

// Converts a position to a PDDL tile identifier
function parseTileId(x: number, y: number): string { return `t_${x}_${y}`; }

// Defines the adjacency predicates for all pairs of adjacent tiles
export const ADJACENCY_DIRS = [
    { dx: 0, dy: 1, pred: "adj-up" },
    { dx: 0, dy: -1, pred: "adj-down" },
    { dx: -1, dy: 0, pred: "adj-left" },
    { dx: 1, dy: 0, pred: "adj-right" },
] as const;

/**
 * Build a PDDL problem string that asks the solver to navigate from `from` (or the agent's
 * current position when omitted) to `target`, pushing any blocking crates out of the way.
 * @param target The tile the agent must reach.
 * @param beliefs Current agent beliefs, used for map layout and crate positions.
 * @param from Optional explicit start position (used to anchor the problem at a crate-cluster
 *   entry tile rather than the live agent position, enabling caching of the maneuver).
 *   When omitted, falls back to the agent's current position from beliefs.
 * @returns A PDDL problem string, or an empty string if required beliefs are unavailable.
 */
export function buildProblem(target: Position, beliefs: Beliefs, from?: Position): string {
    // If the map size is not yet available, we cannot build a valid problem
    const size = beliefs.map.getMapSize();
    if (!size) return "";

    // Convert to integer the start position to avoid issues with PDDL parsing (e.g. t_3.0_5.0 vs t_3_5)
    let me_x: number, me_y: number;
    if (from) {
        me_x = Math.round(from.x);
        me_y = Math.round(from.y);
    } else {
        const me = beliefs.agents.getCurrentMe();
        if (!me?.lastPosition) return "";
        me_x = Math.round(me.lastPosition.x);
        me_y = Math.round(me.lastPosition.y);
    }

    // Generate the list of all non-wall tiles for object declarations and adjacency predicates
    const { width: mapWidth, height: mapHeight } = size;
    const allTiles: Position[] = [];
    for (let y = 0; y < mapHeight; y++) {
        for (let x = 0; x < mapWidth; x++) {
            allTiles.push({ x, y });
        }
    }

    // Generate predicates for agent position, tile adjacencies, crate positions, and crate-free tiles
    const crates = beliefs.map.getCurrentCrates().filter(c => c.lastPosition !== null);
    const cratePositions = new Set(crates.map(c => parseTileId(c.lastPosition!.x, c.lastPosition!.y)));
    const crateSpaces = new Set(beliefs.map.getCrateSpaceTiles().map(t => parseTileId(t.x, t.y)));

    // Initialize the problem with the agent's current position
    const init: string[] = [`(at ${parseTileId(me_x, me_y)})`];

    // Add adjacency predicates for all pairs of adjacent non-wall tiles
    for (const { x, y } of allTiles) {
        for (const { dx, dy, pred } of ADJACENCY_DIRS) {
            const neighborPos = { x: x + dx, y: y + dy };
            // Only add adjacency for tiles where the neighbor is walkable or has a crate
            if (beliefs.map.isWalkable({ x, y }, neighborPos) || beliefs.map.isCrateAt(neighborPos)) {
                init.push(`(${pred} ${parseTileId(x, y)} ${parseTileId(x + dx, y + dy)})`);
            }
        }
    }

    // Add predicates for crate positions and crate-free tiles
    crates.forEach(c => {
        init.push(`(crate-at crate_${c.id} ${parseTileId(c.lastPosition!.x, c.lastPosition!.y)})`);
    });
    allTiles.forEach(t => {
        if (!cratePositions.has(parseTileId(t.x, t.y))) {
            init.push(`(crate-free ${parseTileId(t.x, t.y)})`);
        }
    });

    // Add predicates for crate spaces (tiles that can potentially hold crates)
    crateSpaces.forEach(id => init.push(`(crate-space ${id})`));

    // Declare all tiles and crates as PDDL objects
    const tileList = allTiles.map(t => parseTileId(t.x, t.y)).join(" ");
    const crateList = crates.map(c => `crate_${c.id}`).join(" ");
    const objects = [tileList && `${tileList} - tile`, crateList && `${crateList} - crate`]
        .filter(Boolean).join(" ");

    return `(define (problem crate-clear)
    (:domain deliveroo-crates)
    (:objects ${objects})
    (:init ${init.join(" ")})
    (:goal (and (at ${parseTileId(target.x, target.y)})))
)`;
}
