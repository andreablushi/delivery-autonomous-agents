import { pathIgnoring } from "../../plan/navigation/a_star.js";
import { posKey } from "../../../../utils/metrics.js";
import type { Beliefs } from "../beliefs.js";
import type { Position } from "../../../../models/position.js";
import type { NavigationDesire, ClearCrateDesire } from "../../../../models/desires.js";

/**
 * Check whether any currently believed crate blocks the path from `from` to `desire.target`.
 * If so, return a ClearCrateDesire covering all crates on that path.
 * @param beliefs Current agent beliefs.
 * @param from Agent's current position.
 * @param desire The navigation desire whose target we are trying to reach.
 * @returns A ClearCrateDesire if crates block the path, or null if the path is clear.
 */
export function detectCrateBlock(
    beliefs: Beliefs,
    from: Position,
    desire: NavigationDesire,
): ClearCrateDesire | null {
    const crates = beliefs.map.getCurrentCrates().flatMap(c =>
        c.lastPosition ? [{ id: c.id, position: c.lastPosition }] : [],
    );
    if (crates.length === 0) return null;

    const crateKeys = new Set(crates.map(c => posKey(c.position)));
    const path = pathIgnoring(beliefs, from, desire.target, crateKeys);
    if (!path) return null;

    const crateIds = crates.filter(c => crateKeys.has(posKey(c.position))).map(c => c.id);
    return crateIds.length > 0 ? { type: "CLEAR_CRATE", target: desire.target, crateIds } : null;
}

/**
 * Check whether at least one believed crate still lies on the path from `from` to `target`.
 * Used to drop stale CLEAR_CRATE desires when another agent has already moved the crate.
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
