import type { Beliefs } from "../bdi/belief/beliefs.js";
import type { InjectedIntention } from "../../models/intentions.js";
import type { Position } from "../../models/position.js";

/**
 * Options shared by both hold-injection helpers.
 */
type HoldOpts = {
    releaseZone?: { center: Position; maxDistance: number };
    rendezvousId?: string;
    expiresAt?: number;
    sourceId?: string;
};

/**
 * Build `InjectedIntention` entries from a pre-computed list of tiles.
 * The single canonical implementation of "wrap tiles as HOLD_TILE intentions."
 * Used by rendezvous-commit and red-light-commit.
 */
export function buildHolds(
    tiles: Position[],
    reward: number,
    opts: HoldOpts = {},
): InjectedIntention[] {
    const sourceId = opts.sourceId ?? "coordinator";
    return tiles.map(tile => ({
        desire: {
            type: "HOLD_TILE" as const,
            target: tile,
            sourceId,
            reward,
            releaseZone: opts.releaseZone,
            rendezvousId: opts.rendezvousId,
        },
        expiresAt: opts.expiresAt,
        sourceId,
    }));
}

/**
 * Build `InjectedIntention` entries for a rendezvous hold zone.
 * Snaps to all reachable tiles within `maxDistance` of `center` via `allRendezvousTiles`,
 * then delegates to `buildHolds`.
 *
 * Returns an empty array if no reachable tile exists within the zone.
 */
export function buildRendezvousHolds(
    beliefs: Beliefs,
    from: Position,
    center: Position,
    maxDistance: number,
    reward: number,
    opts: HoldOpts = {},
): InjectedIntention[] {
    const tiles = beliefs.map.allRendezvousTiles(from, center.x, center.y, maxDistance);
    if (tiles.length === 0) return [];
    return buildHolds(tiles, reward, opts);
}
