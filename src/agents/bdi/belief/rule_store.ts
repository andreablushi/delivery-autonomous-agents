import type { Position } from "../../../models/position.js";
import type { ScoringRule } from "../../../models/rules.js";
import { posKey } from "../../../utils/metrics.js";

/**
 * Manages LLM-injected scoring rules that reweight desire scoring each deliberation cycle.
 * Rules are permanent (no TTL) and identified by an LLM-supplied id.
 * When multiple rules match the same context on the same axis, the most recently registered one wins.
 */
export class RuleStore {
    private rules: ScoringRule[] = [];

    /**
     * Add or replace a rule by id. Stamps registeredAt to enforce last-registered-wins ordering.
     * @param rule The rule to upsert.
     */
    upsert(rule: ScoringRule): void {
        this.rules = this.rules.filter(r => r.id !== rule.id);
        this.rules.push({ ...rule, registeredAt: Date.now() });
    }

    /**
     * Remove a rule by id.
     * @param id The id of the rule to remove.
     * @returns true if a rule was removed, false if no rule with that id existed.
     */
    remove(id: string): boolean {
        const before = this.rules.length;
        this.rules = this.rules.filter(r => r.id !== id);
        return this.rules.length !== before;
    }

    /**
     * Return all currently active rules.
     */
    list(): readonly ScoringRule[] {
        return this.rules;
    }

    /**
     * Returns true if any stack_count rule would increase reward (multiplier > 1 or additive > 0).
     */
    hasPositiveStackRule(): boolean {
        return this.rules.some(
            r => r.conditioned_axis === "stack_count" &&
                ((r.effect.multiplier ?? 1) > 1 || (r.effect.additive ?? 0) > 0)
        );
    }

    /**
     * Return the effective multiplier + additive for a given carried parcel count.
     * Finds the most recently registered stack_count rule whose predicate matches, or identity if none.
     * @param carriedCount Number of parcels currently carried by the agent.
     */
    stackCountEffect(carriedCount: number): { multiplier: number; additive: number } {
        const matching = this.rules
            .filter((r): r is Extract<ScoringRule, { conditioned_axis: "stack_count" }> =>
                r.conditioned_axis === "stack_count" && this.matchesCarriedParcelCount(r.predicate, carriedCount))
            .sort((a, b) => b.registeredAt - a.registeredAt);
        return this.applyEffect(matching[0]);
    }

    /**
     * Return the effective multiplier + additive for a given delivery target tile.
     * Finds the most recently registered delivery_tile rule for that tile, or identity if none.
     * @param target The delivery tile position.
     */
    deliveryTileEffect(target: Position): { multiplier: number; additive: number } {
        const key = posKey(target);
        const matching = this.rules
            .filter((r): r is Extract<ScoringRule, { conditioned_axis: "delivery_tile" }> =>
                r.conditioned_axis === "delivery_tile" && posKey(r.tile) === key)
            .sort((a, b) => b.registeredAt - a.registeredAt);
        return this.applyEffect(matching[0]);
    }

    /**
     * Return the effective multiplier + additive for a given parcel reward value.
     * Finds the most recently registered parcel_value rule whose predicate matches, or identity if none.
     * @param reward The current reward value of the parcel.
     */
    parcelValueEffect(reward: number): { multiplier: number; additive: number } {
        const matching = this.rules
            .filter((r): r is Extract<ScoringRule, { conditioned_axis: "parcel_value" }> =>
                r.conditioned_axis === "parcel_value" && this.matchesParcelValue(r.predicate, reward))
            .sort((a, b) => b.registeredAt - a.registeredAt);
        return this.applyEffect(matching[0]);
    }

    /**
     * Helper to extract the multiplier and additive from a rule, or return identity if the rule is undefined.
     * @param rule The rule to extract the effect from, or undefined to return identity.
     */
    private applyEffect(rule: ScoringRule | undefined): { multiplier: number; additive: number } {
        if (!rule) return { multiplier: 1, additive: 0 };
        return { multiplier: rule.effect.multiplier ?? 1, additive: rule.effect.additive ?? 0 };
    }

    /** 
     * Predicates for matching rules 
     * @param pred The predicate object from the rule to match against.
     * @param carriedCount The current number of parcels carried by the agent.
     * @returns true if the predicate matches the current context, false otherwise.
     */
    private matchesCarriedParcelCount(pred: { equals?: number; min?: number; max?: number }, carriedCount: number): boolean {
        if (pred.equals !== undefined && pred.equals !== carriedCount) return false;
        if (pred.min !== undefined && carriedCount < pred.min) return false;
        if (pred.max !== undefined && carriedCount > pred.max) return false;
        return true;
    }

    /**
     * Predicates for matching rules
     * @param pred The predicate object from the rule to match against.
     * @param currentReward The current reward value of the parcel being considered.
     * @returns true if the predicate matches the current context, false otherwise.
     */
    private matchesParcelValue(pred: { minReward?: number; maxReward?: number }, currentReward: number): boolean {
        if (pred.minReward !== undefined && currentReward < pred.minReward) return false;
        if (pred.maxReward !== undefined && currentReward > pred.maxReward) return false;
        return true;
    }
}
