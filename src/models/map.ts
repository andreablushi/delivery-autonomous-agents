import { TileType } from "./tile_type.js";

export type Tile = {
    x: number;    // Tile's column index on the map
    y: number;    // Tile's row index on the map
    type: TileType; // Tile type code indicating the nature of the tile
};

export type GameMap = {
    width: number;   // Number of columns in the map grid
    height: number;  // Number of rows in the map grid
    tiles: TileType[][];  // Row-major 2D matrix; access as tiles[y][x]
};
