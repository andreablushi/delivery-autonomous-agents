import type { Position } from "../../../../models/position.js";

/**
 * Manages collision wait times for tiles that are currently blocked by other agents.
 * When the agent encounters a blocked tile, it can start a timer for that tile
 */
export class CollisionTimer {
    private waitingUntil = 0;
    private waitingTile: Position | null = null;

    /** Resets the collision timer, clearing any waiting state. */
    reset(): void {
        this.waitingTile = null;
        this.waitingUntil = 0;
    }

    /** Checks if the agent is currently waiting for a specific tile. */
    isWaitingFor(tile: Position): boolean {
        return (
            this.waitingTile?.x === tile.x &&
            this.waitingTile?.y === tile.y
        );
    }

    /** 
     * Starts the collision timer for a specific tile, with a random duration between minMs and maxMs.
     * @param tile The position of the tile that is being waited on.
     * @param minMs The minimum duration to wait in milliseconds.
     * @param maxMs The maximum duration to wait in milliseconds.
     * @param now The current timestamp in milliseconds (optional, defaults to Date.now()).
     */
    start(tile: Position, minMs: number, maxMs: number, now = Date.now()): void {
        this.waitingTile = tile;
        this.waitingUntil = now + this.randomDuration(minMs, maxMs);
    }

    /** Returns true if the collision timer has expired. */
    hasExpired(now = Date.now()): boolean {
        return this.waitingUntil > 0 && now >= this.waitingUntil;
    }

    /** Returns a random duration between minMs and maxMs. */
    private randomDuration(minMs: number, maxMs: number): number {
        if (maxMs <= minMs) return minMs;
        return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    }
}
