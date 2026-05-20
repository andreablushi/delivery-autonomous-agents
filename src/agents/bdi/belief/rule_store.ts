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
     * Return the effective multiplier + additive for a given carried parcel count.
     * Finds the most recently registered stack_count rule whose predicate matches, or identity if none.
     * @param carriedCount Number of parcels currently carried by the agent.
     */
    stackCountEffect(carriedCount: number): { multiplier: number; additive: number } {
        const matching = this.rules
            .filter((r): r is Extract<ScoringRule, { conditioned_axis: "stack_count" }> =>
                r.conditioned_axis === "stack_count" && matchesCarriedParcelCount(r.predicate, carriedCount))
            .sort((a, b) => b.registeredAt - a.registeredAt);
        return applyEffect(matching[0]);
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
        return applyEffect(matching[0]);
    }

    /**
     * Return the effective multiplier + additive for a given parcel reward value.
     * Finds the most recently registered parcel_value rule whose predicate matches, or identity if none.
     * @param reward The current reward value of the parcel.
     */
    parcelValueEffect(reward: number): { multiplier: number; additive: number } {
        const matching = this.rules
            .filter((r): r is Extract<ScoringRule, { conditioned_axis: "parcel_value" }> =>
                r.conditioned_axis === "parcel_value" && matchesParcelValue(r.predicate, reward))
            .sort((a, b) => b.registeredAt - a.registeredAt);
        return applyEffect(matching[0]);
    }
}

// Identity effect for when no rules match: multiplier 1, additive 0.
function identity(): { multiplier: number; additive: number } {
    return { multiplier: 1, additive: 0 };
}

/**
 * Given a scoring rule, return its multiplier and additive components, defaulting to identity values if the rule is undefined.
 * @param rule The rule to apply, or undefined for no rule.
 * @returns The multiplier and additive to apply to the base score according to the rule, or identity if no rule.
 */
function applyEffect(rule: ScoringRule | undefined): { multiplier: number; additive: number } {
    if (!rule) return identity();
    return { multiplier: rule.effect.multiplier ?? 1, additive: rule.effect.additive ?? 0 };
}

/**
 * Check if a carried parcel count matches the given predicate, which may specify an exact count or a min/max range.
 * @param pred The predicate to check against ('equals' for exact count, or 'min'/'max' for range).
 * @param count The actual carried parcel count.
 * @returns True if the count matches the predicate, false otherwise.
 */
function matchesCarriedParcelCount(pred: { equals?: number; min?: number; max?: number }, carriedCount: number): boolean {
    if (pred.equals !== undefined && pred.equals !== carriedCount) return false;
    if (pred.min !== undefined && carriedCount < pred.min) return false;
    if (pred.max !== undefined && carriedCount > pred.max) return false;
    return true;
}

function matchesParcelValue(pred: { minReward?: number; maxReward?: number }, currentReward: number): boolean {
    if (pred.minReward !== undefined && currentReward < pred.minReward) return false;
    if (pred.maxReward !== undefined && currentReward > pred.maxReward) return false;
    return true;
}
