import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { BeliefsReport } from "../../../models/message_injection.js";
import { manhattanDistance, posKey, NEIGHBOURS } from "../../../utils/metrics.js";
import { config } from "../../../config.js";

export type ClusterInfo = { centroid: { x: number; y: number }; tileCount: number };

export type TeamGeometry = {
    spawnClusters: ClusterInfo[];
    deliveryClusters: ClusterInfo[];
    /** Midpoint between each spawn cluster and its nearest delivery cluster. */
    midpoints: { x: number; y: number }[];
    /** Top enemy hot zones merged from all teammate reports. */
    hotZones: { x: number; y: number; heat: number }[];
};

/** Group tiles into connected components where adjacency = Manhattan distance 1. */
function clusterTiles(tiles: { x: number; y: number }[]): { x: number; y: number }[][] {
    const tileSet = new Set(tiles.map(t => posKey(t)));
    const visited = new Set<string>();
    const clusters: { x: number; y: number }[][] = [];

    for (const tile of tiles) {
        const key = posKey(tile);
        if (visited.has(key)) continue;

        const cluster: { x: number; y: number }[] = [];
        const queue = [tile];
        visited.add(key);

        while (queue.length > 0) {
            const current = queue.shift()!;
            cluster.push(current);
            for (const n of NEIGHBOURS) {
                const neighbor = { x: current.x + n.x, y: current.y + n.y };
                const nKey = posKey(neighbor);
                if (visited.has(nKey) || !tileSet.has(nKey)) continue;
                visited.add(nKey);
                queue.push(neighbor);
            }
        }
        clusters.push(cluster);
    }
    return clusters;
}

/** Centroid of a set of tiles, rounded to nearest integer. */
function centroid(tiles: { x: number; y: number }[]): { x: number; y: number } {
    const sumX = tiles.reduce((s, t) => s + t.x, 0);
    const sumY = tiles.reduce((s, t) => s + t.y, 0);
    return { x: Math.round(sumX / tiles.length), y: Math.round(sumY / tiles.length) };
}

/**
 * Compute deterministic team geometry from the map and aggregated belief reports.
 * The result is passed to the LLM coordinator as orientation data.
 */
export function buildTeamGeometry(
    beliefs: Readonly<Beliefs>,
    reports: Map<string, BeliefsReport>,
): TeamGeometry {
    const spawnTiles = beliefs.map.getSpawnTiles();
    const deliveryTiles = beliefs.map.getDeliveryTiles();

    const spawnClusterTiles = clusterTiles(spawnTiles);
    const deliveryClusterTiles = clusterTiles(deliveryTiles);

    const spawnClusters: ClusterInfo[] = spawnClusterTiles.map(c => ({
        centroid: centroid(c),
        tileCount: c.length,
    }));
    const deliveryClusters: ClusterInfo[] = deliveryClusterTiles.map(c => ({
        centroid: centroid(c),
        tileCount: c.length,
    }));

    // Midpoint between each spawn cluster centroid and its nearest delivery cluster centroid
    const midpoints: { x: number; y: number }[] = [];
    for (const spawn of spawnClusters) {
        if (deliveryClusters.length === 0) break;
        const nearestDelivery = deliveryClusters.reduce((best, d) =>
            manhattanDistance(spawn.centroid, d.centroid) < manhattanDistance(spawn.centroid, best.centroid) ? d : best
        );
        midpoints.push({
            x: Math.round((spawn.centroid.x + nearestDelivery.centroid.x) / 2),
            y: Math.round((spawn.centroid.y + nearestDelivery.centroid.y) / 2),
        });
    }

    // Merge hotTiles across all reports, keep the top N by heat
    const heatMap = new Map<string, { x: number; y: number; heat: number }>();
    for (const report of reports.values()) {
        for (const ht of report.hotTiles) {
            const key = posKey(ht);
            const existing = heatMap.get(key);
            if (!existing || ht.heat > existing.heat) heatMap.set(key, ht);
        }
    }
    const hotZones = [...heatMap.values()]
        .sort((a, b) => b.heat - a.heat)
        .slice(0, config.coordination.hotZonesLimit);

    return { spawnClusters, deliveryClusters, midpoints, hotZones };
}
