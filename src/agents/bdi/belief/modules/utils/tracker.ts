import { Observation } from "../../../../../models/memory.js";
import { Position } from "../../../../../models/position.js";
import { isHalfPosition } from "../../../../../utils/metrics.js";

type Positionable = { id: string; lastPosition: Position | null };

/**
 * A simple key-value store that tracks the latest value for each key along with the timestamp of when it was last updated.
 */
export class Tracker<T extends Positionable> {
    // Internal mapping from ids to their latest observed value and the timestamp of that observation.
    private store = new Map<string, Observation<T>>();
    private keepHalfPosition: boolean;

    /**
     * Constructor allows configuring whether to keep half positions (non-integer coordinates) in the tracker, which can be useful for tracking moving agents without memorizing intermediate positions.
     * @param keepHalfPosition Whether to keep half positions in the tracker.
     */
    constructor(keepHalfPosition: boolean = false) {
        this.keepHalfPosition = keepHalfPosition;
    }

    /**
     * Update the value for a given id along with the current timestamp.
     * @param key id of the object being tracked
     * @param value the latest observed value for the object
     * @returns void
     */
    update(key: string, value: T): void {
        // Avoid memorizing intermediate positions
        const pos = value.lastPosition;
        if (pos && isHalfPosition(pos) && !this.keepHalfPosition) return;
        // Store the new value along with the current timestamp
        this.store.set(key, { value, seenAt: Date.now() });
    }

    /**
     * Update the value for a given id without changing the existing timestamp.
     * @param key id of the object being tracked
     * @param value the new value to store, preserving the existing seenAt
     * @returns void
     */
    updateValuePreservingTimestamp(key: string, value: T): void {
        // Get previous entry to preserve timestamp; if it doesn't exist, do nothing
        const existing = this.store.get(key);
        if (!existing) return;

        // Avoid memorizing intermediate positions
        const pos = value.lastPosition;
        if (pos && isHalfPosition(pos) && !this.keepHalfPosition) return;

        // Update the object with the new value, keeping old timestamp
        this.store.set(key, { value, seenAt: existing.seenAt });
    }

    /**
     * Get the current value for all keys
     * @returns values for all keys currently stored in the tracker.
     */
    getCurrentAll(): T[] {
        return Array.from(this.store.values()).map(o => o.value);
    }

    /**
     * Get the timestamp of when the given key was last updated, or undefined if the key does not exist.
     * @param key id of the object being tracked
     * @returns The timestamp of the last update for the key, or undefined if the key does not exist.
     */
    getLastTimestamp(key: string): number | undefined {
        return this.store.get(key)?.seenAt;
    }

    /**
     * Delete the entry for a given key from the tracker.
     * @param key id of the object to be deleted from the tracker
     */
    delete(key: string): void {
        this.store.delete(key);
    }

    /**
     * Invalidate lastPosition for tracked objects whose last known position is within the visible area but were not sensed there.
     * If an object's last known position is visible but the object was not sensed at that position, it has moved to an unknown location.
     *
     * NOTE: this doesn't remove the object from the tracker, it just sets its lastPosition to null to indicate that we no longer have a valid location for it.
     * @param sensedItems Items observed in the current sensing window (used to exclude already-sensed objects)
     * @param sensedPositions Positions currently within the agent's visible range
     */
    invalidateAtSensedPositions(sensedItems: Array<{ id: string }>, sensedPositions: Position[]): void {
        const sensedIds = new Set(sensedItems.map(item => item.id));
        this.getCurrentAll().forEach(item => {
            if (sensedIds.has(item.id) || !item.lastPosition) return;
            if (!sensedPositions.some(p => p.x === item.lastPosition!.x && p.y === item.lastPosition!.y)) return;
            this.update(item.id, { ...item, lastPosition: null });
        });
    }

    /**
     * Confidence that the tracked item's last known position is still current, based on observation age.
     * Uses exponential decay: confidence = e^(-age / halfLife), giving 1.0 when just observed and approaching 0.0 as time passes.
     * Returns 0 if the position is already known to be invalid (lastPosition is null).
     * @param key id of the object being tracked
     * @param halfLife time in milliseconds after which confidence drops to ~0.37 (1/e). For example, pass 5000 if you expect
     *                 the item's position to remain accurate for roughly 5 seconds before becoming unreliable.
     * @returns confidence in [0, 1], or undefined if the key is not tracked
     */
    getConfidence(key: string, halfLife: number): number | undefined {
        const entry = this.store.get(key);
        if (!entry) return undefined;
        if (!entry.value.lastPosition) return 0;
        const age = Date.now() - entry.seenAt;
        return Math.exp(-age / halfLife);
    }
}
