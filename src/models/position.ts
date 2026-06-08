
/** Shared 2D grid coordinate used across internal and IO models. */
export type Position = { x: number; y: number };

/** Prediction of an enemy's future position based on observed history. */
export type PositionPrediction = {
    position: Position; // Predicted position of the enemy
    confidence: number; // [0, 1]
};