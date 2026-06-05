import type { GameMap, Tile } from "../../../../models/map.js";
import type { Position } from "../../../../models/position.js";
import type { IOTile } from "../../../../models/djs.js";
import { TILE_TYPE, staticBlocksEntry, type TileType } from "../../../../models/tile_type.js";
import { computeSafeTiles } from "./utils/reachability.js";
import { manhattanDistance, posKey, bfsDistancesFrom, NEIGHBOURS } from "../../../../utils/metrics.js";
import { createLogger, type Logger } from "../../../../utils/logger.js";
import { config } from "../../../../config.js";
import type { CrateBeliefs } from "./crate_beliefs.js";

/** A connected component of same-type tiles with its centroid and tile count. */
export type ClusterInfo = { centroid: Position; tileCount: number };

/**
 * Beliefs about the static map layout.
 * Dynamic crate positions are owned by CrateBeliefs (injected via constructor).
 */
export class MapBeliefs {
    private map: GameMap | null = null;              // Static map layout, set once at the start of the game
    private spawnTiles: Tile[] = [];                 // Precomputed on updateMap; map is static so this never changes
    private deliveryTiles: Tile[] = [];              // Precomputed on updateMap; map is static so this never changes
    private crateSpaceTiles: Tile[] = [];            // Precomputed list of all tiles that can hold crates, used for PDDL problem generation
    private spawnTilesSensingTimes = new Map<string, number>();      // Keep track of when spawn tiles were last sensed, keyed as "x,y"
    private spawnTilesClusterWeights = new Map<string, number>();    // Keep track of how many spawn tiles are in the cluster of each spawn tile, keyed as "x,y"
    private spawnClusters: ClusterInfo[] | null = null;              // Connected-component clusters of spawn tiles, computed lazily after updateMap
    private deliveryClusters: ClusterInfo[] | null = null;           // Connected-component clusters of delivery tiles, computed lazily after updateMap
    private temporaryBlocked = new Map<string, number>();            // Temporary blockers for pathfinding, e.g. tiles that are currently occupied by other agents or crates but may become free soon
    private llmTilePenalties = new Map<string, { id: string; tile: Position; cost: number }>();  // LLM-managed soft traversal costs, keyed by posKey; distinct from temporaryBlocked which is for collision avoidance
    private readonly log: Logger;

    constructor(private readonly crateBeliefs: CrateBeliefs, agentId?: string) {
        this.log = createLogger("map", agentId);
    }

    /**
     * Initialize map beliefs from the given map info.
     * @param width Width of the map in tiles.
     * @param height Height of the map in tiles.
     * @param tiles Initial array of tiles from the server.
     * @returns void
     */
    updateMap(width: number, height: number, tiles: IOTile[]): void {
        // Normalize tile types to strings — the server may send numeric values (e.g. 1) instead of strings ('1')
        const normalizedTiles = tiles.map(t => ({ ...t, type: String(t.type) as TileType }));
        // Pre-fill with WALL so any tile absent from the server payload is treated as unwalkable
        const matrix = Array.from({ length: height }, () =>
            Array<TileType>(width).fill(TILE_TYPE.WALL)
        );
        for (const t of normalizedTiles) {
            matrix[t.y][t.x] = t.type;
        }

        const deliveryPositions = normalizedTiles
            .filter(t => t.type === TILE_TYPE.DELIVERY_POINT)
            .map(t => ({ x: t.x, y: t.y }));
        const spawnPositions = normalizedTiles
            .filter(t => t.type === TILE_TYPE.SPAWN_POINT)
            .map(t => ({ x: t.x, y: t.y }));
        // Seal off conveyor sinks and dead zones: only tiles in SCCs that contain BOTH a
        // spawn and a delivery (a complete pickup-and-deliver loop) survive; everything else
        // is treated as a wall for pathfinding purposes.
        const safeKeys = computeSafeTiles(width, height, matrix, deliveryPositions, spawnPositions, MapBeliefs.isStaticWalkable);

        // Any tile which is not safe can be treated as a wall
        let sealed = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (matrix[y][x] !== TILE_TYPE.WALL && !safeKeys.has(posKey({ x, y }))) {
                    matrix[y][x] = TILE_TYPE.WALL;
                    sealed++;
                }
            }
        }
        this.log.debug(`Sealed ${sealed} sink tiles`);
        this.map = { width, height, tiles: matrix };
        this.logMap();

        // Precompute static tile lists — map never changes after this point.
        // Filter spawn / crate-space tiles through the safe set so callers never see sealed tiles.
        this.spawnTiles = normalizedTiles
            .filter(t => t.type === TILE_TYPE.SPAWN_POINT && safeKeys.has(posKey(t)))
            .map(t => ({ x: t.x, y: t.y, type: t.type }));
        this.deliveryTiles = normalizedTiles
            .filter(t => t.type === TILE_TYPE.DELIVERY_POINT)
            .map(t => ({ x: t.x, y: t.y, type: t.type }));
        this.crateSpaceTiles = normalizedTiles
            .filter(t => (t.type === TILE_TYPE.CRATE_SPACE || t.type === TILE_TYPE.CRATE_OCCUPIED) && safeKeys.has(posKey(t)))
            .map(t => ({ x: t.x, y: t.y, type: t.type }));

        // Pre-compute connected-component clusters for spawn and delivery tiles (map is static).
        this.spawnClusters = buildClusters(this.spawnTiles);
        this.deliveryClusters = buildClusters(this.deliveryTiles);
    }


    /**
     * Log the current map layout to the console with y=0 at the bottom, matching the
     * coordinate system used in the game.
     * Symbols: W=wall, .=floor, S=spawn, D=delivery, C=crate space, <>^v=conveyors, ?=unknown.
     */
    logMap(): void {
        if (!this.map) {
            this.log.debug('map not initialized');
            return;
        }
        const { tiles, width, height } = this.map;
        const symbol = (t: TileType): string => {
            switch (t) {
                case TILE_TYPE.WALL: return ' ';
                case TILE_TYPE.FLOOR: return '.';
                case TILE_TYPE.SPAWN_POINT: return 'S';
                case TILE_TYPE.DELIVERY_POINT: return 'D';
                case TILE_TYPE.CRATE_SPACE:
                case TILE_TYPE.CRATE_OCCUPIED: return 'C';
                case TILE_TYPE.DIRECTIONAL_LEFT: return '<';
                case TILE_TYPE.DIRECTIONAL_RIGHT: return '>';
                case TILE_TYPE.DIRECTIONAL_UP: return '^';
                case TILE_TYPE.DIRECTIONAL_DOWN: return 'v';
                default: return '?';
            }
        };
        const rows = tiles.map(row => row.map(symbol).join(' ')).reverse();
        this.log.debug(
            `${width}x${height} layout (W=wall, .=floor, S=spawn, D=delivery, C=crate, <>^v=conveyors), y=0 at bottom:\n` +
            rows.join('\n')
        );
    }

    /**
     * Width and height of the loaded map, or null if the map has not been received yet.
     * @return An object with width and height properties, or null if map not loaded
     */
    getMapSize(): { width: number; height: number } | null {
        if (!this.map) return null;
        return { width: this.map.width, height: this.map.height };
    }

    /*
    * The full map object, or null if the map has not been received yet.
    */
    getMap(): GameMap | null {
        return this.map;
    }

    checkMapBounds(x: number, y: number): boolean {
        if (!this.map) return false;
        return x >= 0 && x < this.map.width && y >= 0 && y < this.map.height;
    }

    /**
     * Retrieve the tile at a given position, or null if the position is out of bounds or the map is not yet initialized.
     * @param position The position to query for the tile.
     * @returns The tile at the given position, or null if not found or map not initialized.
     */
    getTileAt(position: Position): Tile | null {
        const { x, y } = position;
        if (!this.checkMapBounds(x, y)) return null;
        return { x, y, type: this.map!.tiles[y][x] };
    }

    /**
     * Check if a given position is walkable.
     * @param from The position from which the agent is trying to move
     * @param to The position the agent is trying to move to
     * @returns True if the position is walkable, false otherwise.
     */
    isWalkable(from: Position, to: Position): boolean {
        // Only adjacent tiles can be walked to, to avoid inconsistencies in a sensing
        if (manhattanDistance(from, to) !== 1) return false;

        const tile = this.getTileAt(to);
        if (tile === null) return false;

        // If a crate is currently at this position, it's not walkable
        if (this.crateBeliefs.isCrateAt(to)) return false;

        // If it's temporary blocked (e.g. occupied by another agent), it's not walkable
        if (this.isBlocked(to)) return false;

        return !staticBlocksEntry(tile.type, to.x - from.x, to.y - from.y);
    }

    /**
     * Walkability rule applied directly to a tile matrix, mirroring `MapBeliefs.isWalkable`
     * but using only static tile types and ignoring dynamic beliefs about crates and temporary blockers.
     * @param matrix Tile type matrix indexed as `matrix[y][x]`.
     * @param width Map width for bounds checking.
     * @param height Map height for bounds checking.
     * @param from The position from which the agent is trying to move.
     * @param to The position the agent is trying to move to.
     * @returns True if the position is walkable based on static tile types, false otherwise.
     */
    static isStaticWalkable(matrix: TileType[][], width: number, height: number, from: Position, to: Position): boolean {
        if (to.x < 0 || to.x >= width || to.y < 0 || to.y >= height) return false;
        return !staticBlocksEntry(matrix[to.y][to.x], to.x - from.x, to.y - from.y);
    }


    /**
     * All parcel spawn tiles.
     * @return An array of spawn tiles
     */
    getSpawnTiles(): Tile[] {
        return this.spawnTiles;
    }

    /**
     * Update the sensing times for all spawn tiles based on the positions sensed.
     * @param sensedPositions Array of positions that are currently sensed.
     * @param currentTime The current time to update the sensing times.
     */
    updateSpawnTilesSensingTimes(sensedPositions: Position[], currentTime: number): void {
        // For each sensed position, if it's a spawn tile, update its last sensing time
        sensedPositions.forEach(position => {
            const tile = this.getTileAt(position);
            if (tile && tile.type === TILE_TYPE.SPAWN_POINT) {
                this.spawnTilesSensingTimes.set(posKey(position), currentTime);
            }
        });
    }

    /**
     * Get the last sensing time for a given spawn tile position, or undefined if it has never been sensed.
     * @param position The position of the spawn tile to query.
     * @returns The timestamp of the last sensing of the spawn tile, or undefined if never sensed.
     */
    getSpawnTileSensingTime(position: Position): number | undefined {
        return this.spawnTilesSensingTimes.get(posKey(position));
    }

    /**
     * Compute and cache a distance-weighted cluster weight for every spawn tile.
     * Weight = Σ 1/(dist(tile, neighbor) + 1) for each neighbor within range.
     * Must be called once after observationDistance is known from the config event.
     * @param observationDistance The maximum distance at which the agent can sense tiles, used to determine which spawn tiles are in the same cluster.
     * @returns void
     */
    computeClusterWeights(observationDistance: number): void {
        for (const tile of this.spawnTiles) {
            const weight = this.spawnTiles.reduce((sum, neighbor) => {
                const distance = manhattanDistance(tile, neighbor);
                return distance <= observationDistance
                ? sum + 1 / (distance + 1)
                : sum;
            }, 0);
            this.spawnTilesClusterWeights.set(posKey(tile), weight);
        }
    }

    /**
     * Get the cluster weight for a given spawn tile position,
     * which represents how many spawn tiles are sensed by standing on that tile.
     * @param position The position of the spawn tile to query.
     * @returns The cluster weight of the spawn tile, or 0 if not yet computed.
     * Higher weights indicate tiles that can sense more spawn tiles when stood upon.
     */
    getSpawnTileClusterWeight(position: Position): number {
        return this.spawnTilesClusterWeights.get(posKey(position)) ?? 0;
    }

    /**
     * Connected-component clusters of spawn tiles.
     * Each cluster is a set of adjacent spawn tiles with its centroid and count.
     * Available after the first `updateMap` call; returns [] before that.
     */
    getSpawnClusters(): ClusterInfo[] {
        return this.spawnClusters ?? [];
    }

    /**
     * Connected-component clusters of delivery tiles.
     * Each cluster is a set of adjacent delivery tiles with its centroid and count.
     * Available after the first `updateMap` call; returns [] before that.
     */
    getDeliveryClusters(): ClusterInfo[] {
        return this.deliveryClusters ?? [];
    }

    /**
     * All parcel delivery tiles.
     * @return An array of delivery tiles
     */
    getDeliveryTiles(): Tile[] {
        return this.deliveryTiles;
    }

    /**
     * All tiles that can hold crates, regardless of occupancy.
     * Used for PDDL problem generation.
     * @return An array of crate space tiles
     */
    getCrateSpaceTiles(): Tile[] {
        return this.crateSpaceTiles;
    }

    /**
     * Set (or replace) a soft LLM traversal penalty for a tile.
     * Unlike markBlocked, this does NOT make the tile unwalkable — it adds cost to the A* edge so the planner avoids it when a detour is cheaper.
     * @param id LLM-supplied identifier; re-registering with the same id replaces the previous entry.
     * @param pos The position to penalise.
     * @param cost Additional path cost to apply when stepping onto this tile (must be ≥ 0).
     */
    setTilePenalty(id: string, pos: Position, cost: number): void {
        // Remove any previous entry with this id (it may have been on a different tile)
        for (const [key, entry] of this.llmTilePenalties) {
            if (entry.id === id) { this.llmTilePenalties.delete(key); break; }
        }
        this.llmTilePenalties.set(posKey(pos), { id, tile: pos, cost });
    }

    /**
     * Remove a soft LLM traversal penalty by id.
     * @param id The id of the penalty to remove.
     * @returns true if a penalty was removed, false if no entry with that id existed.
     */
    removeTilePenalty(id: string): boolean {
        for (const [key, entry] of this.llmTilePenalties) {
            if (entry.id === id) { this.llmTilePenalties.delete(key); return true; }
        }
        return false;
    }

    /**
     * Return the soft LLM traversal penalty for a tile, or 0 if none is set.
     * @param pos The position to query.
     */
    getTilePenalty(pos: Position): number {
        return this.llmTilePenalties.get(posKey(pos))?.cost ?? 0;
    }

    /**
     * Return all currently active LLM tile penalties.
     */
    listTilePenalties(): { id: string; tile: Position; cost: number }[] {
        return [...this.llmTilePenalties.values()];
    }

    /**
     * Mark a tile as temporarily blocked for pathfinding purposes
     * @param pos The position to mark as blocked
     * @param ttl How long to keep the tile blocked in milliseconds (default 1000ms)
     */
    markBlocked(pos: Position, ttl: number = config.map.defaultBlockedTtlMs): void {
        this.temporaryBlocked.set(posKey(pos), Date.now() + ttl);
    }

    /**
     * Check if a tile is currently marked as temporarily blocked
     * @param pos The position to check
     * @returns True if the tile is currently blocked, false otherwise
     */
    isBlocked(pos: Position): boolean {
        const key = posKey(pos);
        const exp = this.temporaryBlocked.get(key);
        if (exp === undefined) return false;
        if (Date.now() >= exp) { this.temporaryBlocked.delete(key); return false; }
        return true;
    }

    /**
     * Validate that (x, y) is a legal injection target: map loaded, in bounds, not a wall, not blocked.
     * Returns an error string on failure, null on success.
     */
    validateTargetTile(x: number, y: number): string | null {
        if (!this.map) return "Map not yet loaded";
        if (!this.checkMapBounds(x, y)) return "Coordinates out of map bounds";
        if (this.map.tiles[y][x] === TILE_TYPE.WALL) return "Target tile is a wall";
        if (this.isBlocked({ x, y })) return "Target tile is currently blocked";
        return null;
    }

    /**
     * Return all reachable tiles (by BFS travel distance from `from`) within `maxDistance` manhattan distance of (cx, cy),
     * @param from The position from which to calculate reachable tiles.
     * @param cx The x coordinate of the center of the rendezvous zone.
     * @param cy The y coordinate of the center of the rendezvous zone.
     * @param maxDistance The maximum manhattan distance from (cx, cy) for tiles to be included in the results.
     * @returns An array of positions of reachable tiles within the specified manhattan distance, sorted by ascending travel distance.
     */
    allRendezvousTiles(from: Position, cx: number, cy: number, maxDistance: number): Position[] {
        if (!this.map) return [];
        const { tiles, width, height } = this.map;
        const walkable = (a: Position, b: Position) => MapBeliefs.isStaticWalkable(tiles, width, height, a, b);
        const dists = bfsDistancesFrom(from, walkable);
        const results: { pos: Position; d: number }[] = [];
        for (const [key, d] of dists) {
            const [x, y] = key.split(",").map(Number);
            if (manhattanDistance({ x, y }, { x: cx, y: cy }) > maxDistance) continue;
            results.push({ pos: { x, y }, d });
        }
        return results.sort((a, b) => a.d - b.d).map(r => r.pos);
    }

    /**
     * Return all reachable tiles (by BFS travel distance from `from`) that lie on lines matching the given
     * axis and parity. For example, axis="row" parity="odd" returns tiles where y % 2 === 1, which staggers
     * agents vertically to reduce congestion; axis="column" parity="even" staggers horizontally on even columns.
     * @param from The position from which to calculate reachable tiles.
     * @param axis Whether to filter by row (y coordinate) or column (x coordinate).
     * @param parity Whether to keep tiles on odd or even lines.
     * @returns An array of matching reachable tile positions, sorted by ascending travel distance.
     */
    allLineTiles(from: Position, axis: "row" | "column", parity: "odd" | "even"): Position[] {
        if (!this.map) return [];
        const { tiles, width, height } = this.map;
        const walkable = (a: Position, b: Position) => MapBeliefs.isStaticWalkable(tiles, width, height, a, b);
        const dists = bfsDistancesFrom(from, walkable);
        const results: { pos: Position; d: number }[] = [];
        for (const [key, d] of dists) {
            const [x, y] = key.split(",").map(Number);
            const coord = axis === "row" ? y : x;
            if ((coord % 2 === 1) !== (parity === "odd")) continue;
            results.push({ pos: { x, y }, d });
        }
        return results.sort((a, b) => a.d - b.d).map(r => r.pos);
    }
}

/**
 * Group tiles into connected components where adjacency = Manhattan distance 1.
 * Returns one ClusterInfo per component with its centroid (rounded mean) and tile count.
 */
function buildClusters(tiles: Position[]): ClusterInfo[] {
    const tileSet = new Set(tiles.map(posKey));
    const visited = new Set<string>();
    const clusters: ClusterInfo[] = [];

    for (const tile of tiles) {
        const key = posKey(tile);
        if (visited.has(key)) continue;

        const component: Position[] = [];
        const queue: Position[] = [tile];
        visited.add(key);

        while (queue.length > 0) {
            const current = queue.shift()!;
            component.push(current);
            for (const n of NEIGHBOURS) {
                const neighbor = { x: current.x + n.x, y: current.y + n.y };
                const nKey = posKey(neighbor);
                if (visited.has(nKey) || !tileSet.has(nKey)) continue;
                visited.add(nKey);
                queue.push(neighbor);
            }
        }

        const sumX = component.reduce((s, t) => s + t.x, 0);
        const sumY = component.reduce((s, t) => s + t.y, 0);
        clusters.push({
            centroid: { x: Math.round(sumX / component.length), y: Math.round(sumY / component.length) },
            tileCount: component.length,
        });
    }
    return clusters;
}
