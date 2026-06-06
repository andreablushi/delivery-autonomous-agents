import type { Position } from "./position.js";

/** The valid discriminant values for the `conditioned_axis` field of a scoring rule. */
export const SCORING_AXIS = {
    STACK_COUNT:   "stack_count",
    DELIVERY_TILE: "delivery_tile",
    PARCEL_VALUE:  "parcel_value",
} as const;

export type ScoringAxis = typeof SCORING_AXIS[keyof typeof SCORING_AXIS];

/** Base interface for all scoring rules. */
interface ScoringRuleBase {
  id:             string;
  registeredAt:   number;
}

/** Defines the effect of a scoring rule on the desirability score. */
interface ScoringEffect {
  multiplier?: number;
  additive?:   number;
}

/** Defines a rule that applies to the number of parcels currently carried by the agent. */
interface StackCountRule extends ScoringRuleBase {
  conditioned_axis: typeof SCORING_AXIS.STACK_COUNT;
  predicate: {
    equals?: number;
    min?:    number;
    max?:    number;
  };
  effect: ScoringEffect;
}

/** Defines a rule that applies to a specific delivery tile. */
interface DeliveryTileRule extends ScoringRuleBase {
  conditioned_axis: typeof SCORING_AXIS.DELIVERY_TILE;
  tile:   Position;
  effect: ScoringEffect;
}

/** Defines a rule that applies to the value of individual parcels. */
interface ParcelValueRule extends ScoringRuleBase {
  conditioned_axis: typeof SCORING_AXIS.PARCEL_VALUE;
  predicate: {
    minReward?: number;
    maxReward?: number;
  };
  effect: ScoringEffect;
}

/**
 * A scoring rule modifies the desirability score of potential actions based
 * on a specific aspect (axis) of the current state.
 * Each rule is defined by:
 * - A unique string `id` for identification and management.
 * - A `conditioned_axis` that specifies which aspect of the state it applies to.
 */
export type ScoringRule =
  | StackCountRule
  | DeliveryTileRule
  | ParcelValueRule;
