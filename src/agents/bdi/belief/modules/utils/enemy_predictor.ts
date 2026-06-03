import type { Agent } from "../../../../../models/agent.js";
import type { Observation } from "../../../../../models/memory.js";
import type { Position, PositionPrediction } from "../../../../../models/position.js";
import { posKey } from "../../../../../utils/metrics.js";
import { config } from "../../../../../config.js";

/**
 * Predict the next tile an observed agent will step onto, based on either its current
 * mid-move fractional coordinate or a majority vote over its observed position history.
 * @param agent The agent whose next position we want to predict
 * @param history Recent position observations for this agent (most recent last)
 * @param isWalkable Optional callback to filter out impossible (wall-blocked) predictions
 * @returns Direction prediction with confidence score, or null if insufficient history
 */
export function predictAgentNextPosition(
    agent: Agent,
    history: Observation<Agent>[],
    isWalkable?: (from: Position, to: Position) => boolean,
): PositionPrediction | null {
    // If I don't have a last known position for this enemy, I can't make a prediction about its movement direction, so I return null
    if(!agent.lastPosition) return null;

    // If the enemy is in an half position (not fully in a tile), we can predict that it's moving in the direction of the half position
    const lastPos = agent.lastPosition!;
    if (!Number.isInteger(lastPos.x) || !Number.isInteger(lastPos.y)) {
        const xIsFractional = !Number.isInteger(lastPos.x);
        const yIsFractional = !Number.isInteger(lastPos.y);

        // If both are fractional, it's ambiguous and incosistent
        if (xIsFractional && yIsFractional) return null;

        // Enemy is currently in a half position between two horizontal tiles
        if (xIsFractional) {
            // Enemy is currently in a half position between two tiles horizontally, so we predict it's moving in the x direction towards the tile corresponding to the half position
            const xMove = getFractionalMove(lastPos.x);
            if (!xMove) return null;
            const to = { x: xMove, y: lastPos.y };
            return { position: to, confidence: 1.0 };
        }

        // Enemy is currently in a half position between two tiles vertically
        const yMove = getFractionalMove(lastPos.y);
        if (!yMove || !Number.isInteger(lastPos.x)) return null;
        const to = { x: lastPos.x, y: yMove };
        return { position: to, confidence: 1.0 };
    }

    // Get the history of observed positions for the specified enemy agent
    if (history.length < 5) return null;

    // Retrieve positions from the history of observations
    const positions = history.map(observation => observation.value.lastPosition);
    const votes = new Map<string, { position: Position; count: number }>();
    // Variable to track the last valid position (not diagonal)
    let lastValidNextPosition: Position = { x: lastPos.x, y: lastPos.y };
    let totalValidPairs = 0;

    // Iterate through consecutive position pairs to determine movement direction
    for (let i = 0; i < positions.length - 1; i++) {
        // Retrieve consecutive positions from the history
        const a = positions[i];
        const b = positions[i + 1];
        if (a === null || b === null) continue;

        // Calculate the difference in x and y coordinates to determine movement direction
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (dx !== 0 && dy !== 0) continue; // diagonal ambiguous, skip

        // Only consider valid movements in cardinal directions or stationary, and ignore any pairs that suggest diagonal movement which cannot be clearly categorized
        totalValidPairs++;

        // Filter out directions blocked by walls from the enemy's current position
        const dirCandidate: Position = { x: lastPos.x + dx, y: lastPos.y + dy };
        if (isWalkable && !isWalkable(lastPos, dirCandidate)) continue;

        // The next position is determined by applying the movement direction (dx, dy)
        const nextPosition: Position = { x: b.x + dx, y: b.y + dy };

        // Vote for the determined direction based on this position pair
        const key = posKey(nextPosition);
        const existing = votes.get(key);
        if (existing) existing.count += 1;
        else votes.set(key, { position: nextPosition, count: 1 });
        lastValidNextPosition = nextPosition;
    }

    // If no valid position pairs were found, we cannot make a prediction or are less than 5 observations
    if (totalValidPairs < 5) return null;

    let winner: Position = { x: lastPos.x, y: lastPos.y };
    let maxVotes = 0;
    // Determine the next position with the most votes, and calculate confidence as the proportion of votes for that direction out of total valid pairs
    for (const { position, count } of votes.values()) {
        if (count > maxVotes) { winner = position; maxVotes = count; }
    }

    // If there's a tie in votes, use the last valid direction as a tiebreaker, since it reflects the most recent observed movement trend
    const tied = [...votes.values()].filter(({ count }) => count === maxVotes);
    if (tied.length > 1) winner = lastValidNextPosition;

    // Return the predicted direction along with a confidence score, which is the ratio of votes for the winning direction to the total number of valid position pairs analyzed
    return { position: winner, confidence: maxVotes / totalValidPairs };
}

/**
 * Infers movement intent for a fractional coordinate using threshold bands.
 * Returns null when the value is inside the uncertainty band.
 * @param value The fractional coordinate value to analyze
 * @returns The inferred integer coordinate if confidently towards one tile, or null if within the uncertainty band
 */
function getFractionalMove(value: number): number | null {
    // If the value is close enough to the upper integer, we infer movement towards the upper tile
    const lower = Math.floor(value);
    const upper = Math.ceil(value);
    const fraction = value - lower;
    // If the fractional part is above the upper threshold
    if (fraction >= config.beliefs.enemy.predictionCeilThreshold) return upper;
    if (fraction <= config.beliefs.enemy.predictionFloorThreshold) return lower;
    return null;
}
