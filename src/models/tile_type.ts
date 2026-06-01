export const TILE_TYPE = {
    WALL: '0',              // Not walkable
    SPAWN_POINT: '1',       // Parcel spawn location
    DELIVERY_POINT: '2',    // Parcel delivery location
    FLOOR: '3',             // Normal walkable tile

    CRATE_SPACE: '5',       // Tile that can hold a crate
    CRATE_OCCUPIED: '5!',   // Tile currently occupied by a crate

    CONVEYOR_LEFT: '←',     // Movement forced right → left
    CONVEYOR_UP: '↑',       // Movement forced down → up
    CONVEYOR_RIGHT: '→',    // Movement forced left → right
    CONVEYOR_DOWN: '↓',     // Movement forced up → down
} as const;

export type TileType = (typeof TILE_TYPE)[keyof typeof TILE_TYPE];
