import type { Position } from "./position.js";

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
  conditioned_axis: "stack_count";
  predicate: {
    equals?: number;
    min?:    number;
    max?:    number;
  };
  effect: ScoringEffect;
}

/** Defines a rule that applies to a specific delivery tile. */
interface DeliveryTileRule extends ScoringRuleBase {
  conditioned_axis: "delivery_tile";
  tile:   Position;
  effect: ScoringEffect;
}

/** Defines a rule that applies to the value of individual parcels. */
interface ParcelValueRule extends ScoringRuleBase {
  conditioned_axis: "parcel_value";
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
 * - A `conditioned_axis` that specifies which aspect of the state it applies to:
 *   - "stack_count": the number of parcels currently carried by the agent.
 *   - "delivery_tile": the specific tile being targeted for delivery.
 *   - "parcel_value": the value of individual parcels.
 */
export type ScoringRule =
  | StackCountRule
  | DeliveryTileRule
  | ParcelValueRule;

/** Defines the axes along which scoring rules can be applied. */
export type ScoringAxis = ScoringRule["conditioned_axis"];