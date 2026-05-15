import type { DesireType } from "./desires.js";

/**
 * IntentionQueueEntry represents a desire along with its computed score, used for sorting and selection in the BDI deliberation process.
 */
export type Intention = {
    desire: DesireType;     // The type of desire
    score: number;          // A computed score representing the desirability of this intention
};

// The IntentionQueue is an ordered list of intentions, where the head of the queue is the current intention the agent is committed to pursuing.
export type IntentionQueue = Intention[];

