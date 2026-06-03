import { Position } from "./position.js";

/** A parcel in the game world */
export type Parcel = {
    id: string;                     // Unique identifier for the parcel
    lastPosition: Position | null;  // Position of the parcel on the map
    carriedBy: string | null;       // ID of the agent currently carrying the parcel (null if not being carried)
    reward: number;                 // Current reward value of the parcel
};