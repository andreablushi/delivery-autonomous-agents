/**
 * Projects a parcel's reward forward by `distance` moves.
 * Mirrors the per-tick `reward - 1` rule in parcel_beliefs.ts applyRewardDecay.
 * Returns 0 if the parcel would fully decay before arrival.
 */
export function projectedRewardAfter(
    currentReward: number,
    distance: number,
    movementDurationMs: number,
    decayIntervalMs: number,
): number {
    if (!isFinite(decayIntervalMs) || decayIntervalMs <= 0) return currentReward;
    const ticks = Math.floor(distance * movementDurationMs / decayIntervalMs);
    return Math.max(0, currentReward - ticks);
}
