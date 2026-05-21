import type { GameMap } from "../../../../models/map.js";
import type { ToolContext } from "../context.js";

export function coerceNum(v: unknown): unknown {
    return typeof v === "string" && v.trim() !== "" ? Number(v) : v;
}

export function checkMapBounds(ctx: ToolContext, x: number, y: number): { map: GameMap } | { error: string } {
    const map = ctx.beliefs.map.getMap();
    if (!map) return { error: "Map not yet loaded" };
    if (x < 0 || x >= map.width || y < 0 || y >= map.height) return { error: "Coordinates out of map bounds" };
    return { map };
}
