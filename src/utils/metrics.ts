import type { Position } from "../models/position.js";

/** Manhattan distance between two grid positions. */
export function manhattanDistance(a: Position, b: Position): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Given the current position and a target position, computes the direction of next step. */
export function posToDirection(from: Position, to: Position): string {
    if (to.x > from.x) return "right";
    if (to.x < from.x) return "left";
    if (to.y > from.y) return "up";
    return "down";
}

/** Stable string key for a grid position, suitable for Map/Set lookups. */
export function posKey(pos: Position): string {
    return `${pos.x},${pos.y}`;
}

/** True if either coordinate is non-integer (i.e. the agent is mid-move between tiles). */
export function isHalfPosition(pos: Position): boolean {
    return !Number.isInteger(pos.x) || !Number.isInteger(pos.y);
}

export const NEIGHBOURS: Position[] = [
    { x: 0, y: 1 },
    { x: 0, y: -1 },
    { x: -1, y: 0 },
    { x: 1, y: 0 },
];

/**
 * BFS from `source` using the given walkability predicate (walls-only or full).
 * Returns a map from posKey to step count. Source is included with distance 0.
 * Tiles unreachable under the predicate are absent from the result.
 */
export function bfsDistancesFrom(
    source: Position,
    isWalkable: (from: Position, to: Position) => boolean,
): Map<string, number> {
    const dist = new Map<string, number>();
    const queue: Position[] = [source];
    dist.set(posKey(source), 0);

    while (queue.length > 0) {
        const current = queue.shift()!;
        const d = dist.get(posKey(current))!;
        for (const delta of NEIGHBOURS) {
            const next: Position = { x: current.x + delta.x, y: current.y + delta.y };
            const key = posKey(next);
            if (dist.has(key)) continue;
            if (!isWalkable(current, next)) continue;
            dist.set(key, d + 1);
            queue.push(next);
        }
    }

    return dist;
}