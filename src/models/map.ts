import { TileType } from "./tile_type.js";

/** Represents a single tile on the game map. */
export type Tile = {
    x: number;      // Tile's column index on the map
    y: number;      // Tile's row index on the map
    type: TileType; // Tile type code indicating the nature of the tile
};

/** Represents the entire game map as a grid of tiles.*/
export type GameMap = {
    width: number;        // Number of columns in the map grid
    height: number;       // Number of rows in the map grid
    tiles: TileType[][];  // Row-major 2D matrix; access as tiles[y][x]
};
