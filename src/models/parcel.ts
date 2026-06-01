import { Position } from "./position.js";

/**
 * Parcel model types for the delivery autonomous agents system.
 * These types represent the internal belief state about parcels in the game world.
*/
export type Parcel = {
    id: string;                     // Unique identifier for the parcel
    lastPosition: Position | null;  // Position of the parcel on the map
    carriedBy: string | null;       // ID of the agent currently carrying the parcel (null if not being carried)
    reward: number;                 // Current reward value of the parcel
};