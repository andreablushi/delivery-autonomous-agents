import { Observation } from "../../../../../models/memory.js";
import { isHalfPosition } from "../../../../../utils/metrics.js";

/**
 * Generic memory store with TTL-based soft expiry.
 * Allows the agent to maintain a history of observations for each id,
 * while automatically evicting stale entries based on a specified time-to-live (TTL).
 */
export class Memory<T> {
    // Internal mapping from ids to arrays of timestamped entries (history).
    private memoryMap = new Map<string, Observation<T>[]>();

    /**
     * @param ttl - Time-to-live for entries in milliseconds.
     * @param historySize - Maximum number of historical entries to keep per id.
     */
    constructor(private ttl: number, private historySize: number) {}

    /**
     * Add a new observation for the given id, along with the current timestamp.
     * @param key id of the object being tracked
     * @param value the latest observed value for the object
     * @returns void
     */
    update(key: string, value: T): void {
        // Avoid memoryzing intermediate positions
        const pos = (value as any)?.lastPosition;
        if (pos && isHalfPosition(pos)) return;

        // Initialize history array for new ids
        if (!this.memoryMap.has(key)){
            this.memoryMap.set(key, []);
        }

        // Append the new observation with the current timestamp
        const entries = this.memoryMap.get(key)!;
        entries.push({ value, seenAt: Date.now() });

        // Keep only the latest observations to bound per-id history size.
        if (entries.length > this.historySize) {
            entries.splice(0, entries.length - this.historySize);
        }
    }

    /**
     * Get all observations for the given key within the TTL window.
     * @param key id of the object being tracked
     * @returns An array of values for the key within the TTL window.
     */
    getHistory(key: string): Observation<T>[] {
        const now = Date.now();
        return (this.memoryMap.get(key) ?? [])
            .filter(e => now - e.seenAt <= this.ttl);
    }

    /**
     * Evict entries that are older than the TTL.
     * If all entries for a key are stale, remove the key entirely.
     * This method should be called periodically to prevent unbounded memory growth.
     * @returns void
    */
    evict(): void {
        const now = Date.now();
        // Check each entry in the memory map and filter out stale observations
        for (const [key, entries] of this.memoryMap.entries()) {
            // Keep only the entries that are within the TTL window
            const fresh = entries.filter(entry => now - entry.seenAt <= this.ttl);
            if (fresh.length > 0) {
                this.memoryMap.set(key, fresh);
            }
            else {
                this.memoryMap.delete(key);
            }
        }
    }
}
