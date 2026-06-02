import type { IOClockEvent } from "../models/djs.js";

/**
 * Converts an IOClockEvent string to milliseconds.
 * Valid values: 'frame' | '1s' | '2s' | '5s' | '10s' | 'infinite'
 * @param event The clock event string from the config
 * @returns The corresponding time interval in milliseconds
 */
export function parseTimeInterval(event: IOClockEvent): number {
    if (event === "infinite") return Number.POSITIVE_INFINITY;
    if (event === "frame") return 0;
    const match = event.match(/^(\d+)s$/);
    if (!match){
        console.warn(`Unrecognized time interval format: "${event}". Defaulting to 1 second.`);
        return 1_000; // Default to 1 second if unrecognized format
    }
    return Number(match[1]) * 1_000;
}
