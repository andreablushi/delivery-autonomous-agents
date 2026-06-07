import { fileURLToPath } from "url";
import { dirname } from "path";
import type { Beliefs } from "../../../bdi/belief/beliefs.js";
import type { RuleStore } from "../../../bdi/desire/rule_store.js";
import type { BeliefsReport } from "../../../../models/message_injection.js";
import type { TeamGeometry } from "../../../cooperation/geometry.js";
import { render } from "../shared.js";

const DIR = dirname(fileURLToPath(import.meta.url));

/** Build the system and user prompts for a team cooperation pass. */
export function buildCooperationPrompt(
    reports: Map<string, BeliefsReport>,
    geometry: TeamGeometry,
    beliefs: Readonly<Beliefs>,
    ruleStore: RuleStore,
    missionNote = "",
    performance = "",
): { system: string; user: string } {
    const me = beliefs.agents.getCurrentMe();
    const myId = me?.id ?? "unknown";
    const myPos = beliefs.agents.getCurrentPosition();
    const carried = me ? beliefs.parcels.getCarriedByAgent(me.id).length : 0;

    // Roster
    const rosterLines: string[] = [];
    const myPosStr = myPos ? `(${myPos.x},${myPos.y})` : "unknown";
    rosterLines.push(`You (id: ${myId}): pos=${myPosStr}, carrying=${carried}`);
    for (const [id, report] of reports) {
        const posStr = report.pos ? `(${report.pos.x},${report.pos.y})` : "unknown";
        const enemiesStr = report.enemies.length > 0
            ? ` enemies=[${report.enemies.map(e => `(${e.x},${e.y})`).join(",")}]` : "";
        const hotStr = report.hotTiles.length > 0
            ? ` hotTiles=[${report.hotTiles.map(t => `(${t.x},${t.y},h=${t.heat.toFixed(2)})`).join(",")}]` : "";
        rosterLines.push(`Teammate ${id}: pos=${posStr}, carrying=${report.carrying}${enemiesStr}${hotStr}`);
    }

    // Geometry
    const geoLines: string[] = [];
    geoLines.push(`Spawn region: ${geometry.totalSpawnTiles} total tiles, ${geometry.spawnClusters.length} cluster(s), region diameter=${geometry.spawnRegionDiameter} tiles`);
    geometry.spawnClusters.forEach((c, i) =>
        geoLines.push(`  Cluster ${i + 1}: centroid=(${c.centroid.x},${c.centroid.y}), ${c.tileCount} tiles`)
    );
    geoLines.push(`Delivery zones (${geometry.deliveryClusters.length}):`);
    geometry.deliveryClusters.forEach((c, i) =>
        geoLines.push(`  Zone ${i + 1}: centroid=(${c.centroid.x},${c.centroid.y}), ${c.tileCount} tiles`)
    );
    const midStr = geometry.midpoints.length > 0
        ? geometry.midpoints.map(m => `(${m.x},${m.y})`).join(" ") : "none";
    geoLines.push(`Midpoints (spawn→delivery): ${midStr}`);
    geoLines.push(`Single-file corridor: ${geometry.singleFile ? "yes (agents cannot pass each other)" : "no"}`);
    geoLines.push(`Spawn→delivery separation: ${geometry.spawnDeliverySeparation !== null ? `${geometry.spawnDeliverySeparation} tiles` : "unknown"}`);
    if (geometry.hotZones.length > 0) {
        geoLines.push(`Hot zones: ${geometry.hotZones.map(z => `(${z.x},${z.y}) heat=${z.heat.toFixed(2)}`).join(" ")}`);
    }

    const roster = rosterLines.join("\n");
    const geometryStr = geoLines.join("\n");
    const context = [beliefs.summarize(), ruleStore.format()].filter(Boolean).join("\n");

    const missionLine = missionNote.trim() ? `Active mission directive: ${missionNote.trim()}` : "";

    return {
        system: render(DIR, "system", {}),
        user: render(DIR, "user", { roster, geometry: geometryStr, context, missionNote: missionLine, performance }),
    };
}
