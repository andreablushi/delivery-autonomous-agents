import type { Position } from "../../../../models/position.js";
import { manhattanDistance, posKey, NEIGHBOURS } from "../../../../utils/metrics.js";
import type { Beliefs } from "../../belief/beliefs.js";
import { toMoveSteps } from "../utils/action_mapper.js";
import type { PlanStep } from "../../../../models/plan.js";

type Node = {
    pos: Position;       // Position of the node
    g: number;           // Cost from start to this node
    f: number;           // Estimated total cost from start to goal through this node (g + heuristic)
    parent: Node | null; // Parent node in the path, used for path reconstruction
};


/**
 * Find the shortest path from `start` to `goal` using A*.
 * @param start      Starting position (not included in the returned path).
 * @param goal       Target position (included in the returned path).
 * @param isWalkable Predicate that returns true for passable tiles.
 * @returns          Ordered array of positions from the step after `start` to
 *                   `goal`, or `null` if no path exists.
 */
export function aStar(
    start: Position,
    goal: Position,
    isWalkable: (from: Position, to: Position) => boolean,
): Position[] | null {
    const open = new Map<string, Node>();
    const closed = new Set<string>();

    const startNode: Node = { pos: start, g: 0, f: manhattanDistance(start, goal), parent: null };
    open.set(posKey(start), startNode);

    while (open.size > 0) {
        // Pick node with lowest f
        let current: Node | null = null;
        for (const node of open.values()) {
            if (!current || node.f < current.f) current = node;
        }
        if (!current) break;

        const key = posKey(current.pos);
        open.delete(key);
        closed.add(key);

        if (current.pos.x === goal.x && current.pos.y === goal.y) {
            // Reconstruct path (exclude start)
            const path: Position[] = [];
            let node: Node | null = current;
            while (node && node.parent) {
                path.unshift(node.pos);
                node = node.parent;
            }
            return path;
        }

        for (const delta of NEIGHBOURS) {
            const neighbour: Position = { x: current.pos.x + delta.x, y: current.pos.y + delta.y };
            const nKey = posKey(neighbour);

            if (closed.has(nKey)) continue;
            if (!isWalkable(current.pos, neighbour)) continue;

            const g = current.g + 1;
            const existing = open.get(nKey);
            if (existing && existing.g <= g) continue;

            open.set(nKey, { pos: neighbour, g, f: g + manhattanDistance(neighbour, goal), parent: current });
        }
    }

    return null; // no path found
}

/**
 * Find a path from `from` to `to` that treats a set of tiles as passable regardless of walkability.
 * Used for crate-block detection: proves a target is reachable once the ignored tiles are cleared.
 */
export function pathIgnoring(
    beliefs: Beliefs,
    from: Position,
    to: Position,
    ignored: Set<string>,
): Position[] | null {
    return aStar(from, to, (f, t) => ignored.has(posKey(t)) || beliefs.map.isWalkable(f, t));
}

/**
 * Compute the move steps from `from` to `to` using A*, optionally treating one tile as impassable.
 */
export function stepsTo(
    beliefs: Beliefs,
    from: Position,
    to: Position,
    blockedTile: Position | null = null,
): PlanStep[] | null {
    const path = aStar(from, to, (f, t) =>
        !(blockedTile && t.x === blockedTile.x && t.y === blockedTile.y) &&
        beliefs.map.isWalkable(f, t),
    );
    return path ? toMoveSteps(from, path) : null;
}
