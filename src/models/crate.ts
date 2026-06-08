import { Position } from "./position.js";

/** A crate in the game world */
export type Crate = {
    id: string;                     // Unique identifier for the crate
    lastPosition: Position | null;  // Position of the crate on the map
};

/** A crate whose position is known */
export type LocatedCrate = {
    id: string;
    position: Position;
};
