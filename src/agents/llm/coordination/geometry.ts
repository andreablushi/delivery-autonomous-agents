import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { BeliefsReport } from "../../../models/message_injection.js";
import type { ClusterInfo } from "../../bdi/belief/modules/map_beliefs.js";
import { posKey, nearestByManhattan } from "../../../utils/metrics.js";
import { config } from "../../../config.js";

export type { ClusterInfo };

export type TeamGeometry = {
    spawnClusters: ClusterInfo[];
    deliveryClusters: ClusterInfo[];
    /** Midpoint between each spawn cluster and its nearest delivery cluster. */
    midpoints: { x: number; y: number }[];
    /** Top enemy hot zones merged from all teammate reports. */
    hotZones: { x: number; y: number; heat: number }[];
};

/**
 * Compute deterministic team geometry from the map and aggregated belief reports.
 * The result is passed to the LLM coordinator as orientation data.
 */
export function buildTeamGeometry(
    beliefs: Readonly<Beliefs>,
    reports: Map<string, BeliefsReport>,
): TeamGeometry {
    const spawnClusters = beliefs.map.getSpawnClusters();
    const deliveryClusters = beliefs.map.getDeliveryClusters();

    // Midpoint between each spawn cluster centroid and its nearest delivery cluster centroid
    const midpoints: { x: number; y: number }[] = [];
    for (const spawn of spawnClusters) {
        if (deliveryClusters.length === 0) break;
        const nearestDelivery = nearestByManhattan(spawn.centroid, deliveryClusters.map(d => d.centroid));
        if (!nearestDelivery) break;
        midpoints.push({
            x: Math.round((spawn.centroid.x + nearestDelivery.x) / 2),
            y: Math.round((spawn.centroid.y + nearestDelivery.y) / 2),
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
