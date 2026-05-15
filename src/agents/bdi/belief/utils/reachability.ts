import type { Position } from "../../../../models/position.js";
import { TILE_TYPE, type TileType } from "../../../../models/tile_type.js";
import { posKey, NEIGHBOURS } from "../../../../utils/metrics.js";

type TileWalkable = (matrix: TileType[][], width: number, height: number, from: Position, to: Position) => boolean;

/**
 * Identify every tile that belongs to a Strongly Connected Component (SCC) containing 
 * at least one delivery tile AND at least one spawn tile, in the directed walkability 
 * graph defined by tile types (conveyors enforce one-way edges).
 *
 * Requiring both a spawn and a delivery in the same SCC captures the agent's operating
 * loop: pickup → deliver → pickup. SCCs with a delivery but no spawn are one-way traps
 * (the agent can enter and deliver once, but cannot return to pick up the next parcel);
 * SCCs with a spawn but no delivery are dead ends where parcels can be picked up but
 * never dropped. Both are sealed.
 *
 * Implemented with the textbook recursive form of Tarjan's algorithm. Deliveroo.js maps
 * are small enough that DFS depth (bounded by width * height) stays well within the V8
 * stack. Walls are skipped — they have no edges and can never be safe.
 *
 * @param width Map width.
 * @param height Map height.
 * @param matrix Tile type matrix indexed as `matrix[y][x]`.
 * @param deliveryTiles List of delivery tile positions.
 * @param spawnTiles List of spawn tile positions.
 * @returns Set of `posKey(x,y)` strings for safe tiles.
 */
export function computeSafeTiles(
    width: number,
    height: number,
    matrix: TileType[][],
    deliveryTiles: Position[],
    spawnTiles: Position[],
    isWalkable: TileWalkable,
): Set<string> {
    const safe = new Set<string>();
    if (deliveryTiles.length === 0 || spawnTiles.length === 0) return safe;

    const N = width * height;
    // Helper to convert (x,y) to node index in the Tarjan algorithm
    const idx = (x: number, y: number) => y * width + x;
    // Helper to check if a tile is walkable (i.e. not a wall) in the static graph            
    const isNode = (x: number, y: number) => matrix[y][x] !== TILE_TYPE.WALL;

    // Tarjan state
    const index = new Int32Array(N);        // DFS visitation index; -1 means unvisited
    const lowlink = new Int32Array(N);      // Lowlink values for root detection
    const onStack = new Uint8Array(N);      // Boolean stack membership for lowlink updates
    const sccId = new Int32Array(N);        // SCC ID for each node; -1 means unassigned
    // Initialize all nodes as unvisited and unassigned
    index.fill(-1);                          
    sccId.fill(-1);

    const tarjanStack: number[] = [];
    let nextIndex = 0;
    let nextScc = 0;

    /**
     * Standard Tarjan's strongconnect function, adapted to our graph structure and walkability rules.
     * @param x Starting node's x coordinate
     * @param y Starting node's y coordinate
     */
    const strongconnect = (
        x: number, 
        y: number
    ): void => {
        // Set the depth index for v to the smallest unused index
        const v = idx(x, y);
        index[v] = nextIndex;
        lowlink[v] = nextIndex;
        nextIndex++;
        
        // Push v on the stack
        tarjanStack.push(v);
        onStack[v] = 1;

        // For each successor w of v:
        for (const delta of NEIGHBOURS) {
            // Check that the coordinates are within bounds
            const nx = x + delta.x;
            const ny = y + delta.y;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            
            // Check that the edge from v to w is walkable according to static tile types
            if (!isNode(nx, ny)) continue;
            if (!isWalkable(matrix, width, height, { x, y }, { x: nx, y: ny })) continue;

            const w = idx(nx, ny);
            // If w has not yet been visited, recurse on it and propagate its lowlink up to v.
            if (index[w] === -1) {
                strongconnect(nx, ny);
                // After recursion, if w is in a different SCC, propagate its lowlink up to v.
                if (lowlink[w] < lowlink[v]) lowlink[v] = lowlink[w];
            } 
            // If w is on the stack, then it's in the current search path and we have a back-edge to it — update lowlink.
            else if (onStack[w]) {
                // Back-edge to a node still on the Tarjan stack — update lowlink.
                if (index[w] < lowlink[v]) lowlink[v] = index[w];
            }
        }
        // If v is a root node of an SCC, pop the stack and generate an SCC.
        if (lowlink[v] === index[v]) {
            // All the nodes on the stack from v up to the current top of the stack form an SCC. Pop them and assign them a common SCC ID.
            while (true) {
                const w = tarjanStack.pop()!;
                onStack[w] = 0;
                sccId[w] = nextScc;
                if (w === v) break;
            }
            nextScc++;
        }
    };
    // For each node in the graph, if it has not been visited, start a DFS traversal from it.
    for (let y0 = 0; y0 < height; y0++) {
        for (let x0 = 0; x0 < width; x0++) {
            if (!isNode(x0, y0) || index[idx(x0, y0)] !== -1) continue;
            strongconnect(x0, y0);
        }
    }

    // Safe SCCs must contain BOTH a delivery tile AND a spawn tile — i.e. a complete
    // pickup-and-deliver loop. SCCs with only one role are unrecoverable dead zones.
    const sccHasDelivery = new Set<number>();
    for (const d of deliveryTiles) {
        const s = sccId[idx(d.x, d.y)];
        if (s !== -1) sccHasDelivery.add(s);
    }
    const safeSccs = new Set<number>();
    for (const sp of spawnTiles) {
        const s = sccId[idx(sp.x, sp.y)];
        if (s !== -1 && sccHasDelivery.has(s)) safeSccs.add(s);
    }

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const s = sccId[idx(x, y)];
            if (s !== -1 && safeSccs.has(s)) safe.add(posKey({ x, y }));
        }
    }

    return safe;
}
