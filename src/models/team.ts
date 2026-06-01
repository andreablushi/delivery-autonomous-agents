import type { Position } from "./position.js";

/** Compact belief snapshot sent by a BDI teammate in response to a request_beliefs envelope. */
export type BeliefsReport = {
    pos: Position | null;
    carrying: number;
    enemies: Position[];
    hotTiles: { x: number; y: number; heat: number }[];
    nearestDelivery: Position | null;
};
