import type { IOConfig } from "../../../models/djs.js";
import { parseTimeInterval } from "../../../utils/time.js";
import type { GameSettings } from "../../../models/game_configs.js";
import type { BeliefsReport } from "../../../models/message_injection.js";
import { AgentBeliefs } from "./modules/agent_beliefs.js";
import { MapBeliefs } from "./modules/map_beliefs.js";
import { ParcelBeliefs } from "./modules/parcel_beliefs.js";
import { CrateBeliefs } from "./modules/crate_beliefs.js";
import { TILE_TYPE } from "../../../models/tile_type.js";
import { manhattanDistance } from "../../../utils/metrics.js";
import { config as appConfig } from "../../../config.js";


/** Central repository for all beliefs held by the BDI agent */
export class Beliefs {
    // Belief sub-systems
    readonly agents: AgentBeliefs;      // Tracks me, friends, and enemies
    readonly map: MapBeliefs;           // Tracks static map layout and tile metadata
    readonly crates: CrateBeliefs;      // Tracks dynamic crate positions
    readonly parcels: ParcelBeliefs;    // Tracks parcels and their statuses

    // Centralized game settings distributed to sub-systems on arrival
    settings: GameSettings | null = null;

    constructor(agentId?: string, teammateIds?: string[]) {
        this.agents = new AgentBeliefs(new Set(teammateIds ?? []));
        this.crates = new CrateBeliefs();
        this.map = new MapBeliefs(this.crates, agentId);
        this.parcels = new ParcelBeliefs();
    }

    /** Build a compact belief snapshot for sending to the LLM coordinator. */
    buildReport(): BeliefsReport {
        const me = this.agents.getCurrentMe();
        const pos = this.agents.getCurrentPosition();
        const carrying = me ? this.parcels.getCarriedByAgent(me.id).length : 0;

        const enemies = this.agents.getCurrentEnemies()
            .map(e => e.lastPosition)
            .filter((p): p is NonNullable<typeof p> => p !== null);

        const hotTiles: { x: number; y: number; heat: number }[] = [];
        const map = this.map.getMap();
        const size = this.map.getMapSize();
        if (map && size) {
            for (let y = 0; y < size.height; y++) {
                for (let x = 0; x < size.width; x++) {
                    if (map.tiles[y][x] === TILE_TYPE.WALL) continue;
                    const heat = this.agents.getEnemyHeatAt({ x, y });
                    if (heat > 0) hotTiles.push({ x, y, heat });
                }
            }
            hotTiles.sort((a, b) => b.heat - a.heat);
            hotTiles.splice(appConfig.report.hotTilesLimit);
        }

        const deliveryTiles = this.map.getDeliveryTiles();
        let nearestDelivery: typeof pos = null;
        if (pos && deliveryTiles.length > 0) {
            nearestDelivery = deliveryTiles.reduce((best, tile) =>
                manhattanDistance(pos, tile) < manhattanDistance(pos, best) ? tile : best
            );
        }

        return { pos, carrying, enemies, hotTiles, nearestDelivery };
    }

    /**
     * Produce a human/LLM-readable summary of all owned belief state:
     * map dimensions, current position, carried parcels, delivery tiles, and traversal penalties.
     * Scoring rules are NOT included here — use RuleStore.format() for those.
     */
    summarize(): string {
        const map = this.map.getMap();
        const me = this.agents.getCurrentMe();
        const deliveryTiles = this.map.getDeliveryTiles();
        const carried = me ? this.parcels.getCarriedByAgent(me.id) : [];

        const parts: string[] = [];
        if (map) parts.push(`Map size: ${map.width}x${map.height}`);
        if (me?.lastPosition) parts.push(`My position: (${me.lastPosition.x}, ${me.lastPosition.y})`);
        parts.push(`Carrying: ${carried.length} parcel${carried.length !== 1 ? "s" : ""}${carried.length > 0 ? ` (ids: ${carried.map(p => p.id).join(", ")})` : ""}`);
        if (deliveryTiles.length > 0)
            parts.push(`Delivery tiles: ${deliveryTiles.map(t => `(${t.x},${t.y})`).join(" ")}`);

        const penalties = this.map.listTilePenalties();
        if (penalties.length > 0) {
            const penaltyLines = penalties.map(p => `  [${p.id}] tile(${p.tile.x},${p.tile.y}) cost=${p.cost}`);
            parts.push(`Active traversal penalties:\n${penaltyLines.join("\n")}`);
        }

        return parts.join("\n");
    }

    /**
     * Set game configuration and distribute relevant slices to each sub-system.
     * @param config Raw config from the server
     * @returns void
     */
    setSettings(config: IOConfig): void {
        this.settings = {
            title: config.GAME.title,
            description: config.GAME.description,
            max_player: config.GAME.maxPlayers,
            clock: config.CLOCK,
        };
        // Distribute relevant config slices to sub-systems
        this.agents.setSettings({
            movement_duration: config.GAME.player.movement_duration,
            observation_distance: config.GAME.player.observation_distance,
            carry_capacity: config.GAME.player.capacity,
        });
        this.parcels.setSettings({
                parcel_spawn_interval: parseTimeInterval(config.GAME.parcels.generation_event),
                reward_decay_interval: parseTimeInterval(config.GAME.parcels.decaying_event),
                max_concurrent_parcels: config.GAME.parcels.max,
                reward_avg: config.GAME.parcels.reward_avg,
                reward_variance: config.GAME.parcels.reward_variance,
        })
    }
}
