import { Position } from "./position.js";

/**
 * Crate model types for the delivery autonomous agents system.
 * These types represent the internal belief state about crates in the game world.
*/

export type Crate = {
    id: string;                     // Unique identifier for the crate
    lastPosition: Position | null;  // Position of the crate on the map
};

/** A crate whose position is known (resolved from `Crate.lastPosition`). */
export type LocatedCrate = {
    id: string;
    position: Position;
};
