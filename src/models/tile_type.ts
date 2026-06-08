export const TILE_TYPE = {
    WALL: '0',              // Not walkable
    SPAWN_POINT: '1',       // Parcel spawn location
    DELIVERY_POINT: '2',    // Parcel delivery location
    FLOOR: '3',             // Normal walkable tile

    CRATE_SPACE: '5',       // Tile that can hold a crate
    CRATE_OCCUPIED: '5!',   // Tile currently occupied by a crate

    DIRECTIONAL_LEFT: '←',     // BLOCKS movement entering the tile from the left → right
    DIRECTIONAL_UP: '↑',       // BLOCKS movement entering the tile from down → up
    DIRECTIONAL_RIGHT: '→',    // BLOCKS movement entering the tile from right → left
    DIRECTIONAL_DOWN: '↓',     // BLOCKS movement entering the tile from up → down
} as const;

export type TileType = (typeof TILE_TYPE)[keyof typeof TILE_TYPE];

/**
 * Static entry rule: does this tile type block an agent entering it via step (dx, dy)?
 * Covers walls (always blocked) and directional/conveyor tiles (blocked from the
 * direction opposing their push). Ignores dynamic state (crates, blockers, penalties).
 * @param dx to.x - from.x   @param dy to.y - from.y (each -1, 0, or +1)
 */
export function staticBlocksEntry(type: TileType, dx: number, dy: number): boolean {
    switch (type) {
        case TILE_TYPE.WALL:              return true;
        case TILE_TYPE.DIRECTIONAL_LEFT:  return dx === 1;   // entering from the left, against ←
        case TILE_TYPE.DIRECTIONAL_RIGHT: return dx === -1;  // entering from the right, against →
        case TILE_TYPE.DIRECTIONAL_UP:    return dy === -1;  // entering from above, against ↑
        case TILE_TYPE.DIRECTIONAL_DOWN:  return dy === 1;   // entering from below, against ↓
        default:                          return false;
    }
}
