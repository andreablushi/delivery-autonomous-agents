import { Position } from "./position.js";

/**
 * Agent model types for the delivery autonomous agents system.
 * These types represent the internal belief state about agents in the game world.
 */

export type Agent = {
    id: string;                     // Unique identifier for the agent
    name: string;                   // Display name of the agent
    teamName: string;               // Identifier of the team the agent belongs to
    score: number;                  // Agent's accumulated score
    penalty: number;                // Penalty points accumulated by the agent
    lastPosition: Position | null;  // Last observed position of the agent (null if never seen)
};
