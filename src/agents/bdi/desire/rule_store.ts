import type { Position } from "../../../models/position.js";
import type { ScoringRule } from "../../../models/rules.js";
import { SCORING_AXIS } from "../../../models/rules.js";
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
     * Format all active scoring rules into a human/LLM-readable string.
     * Returns an empty string when no rules are active (safe to filter out).
     */
    format(): string {
        // If there are no active rules, return an empty string
        if (this.rules.length === 0) return "";
        
        // Otherwise, format each rule into a readable string and join them with newlines
        const ruleLines = this.rules.map(r => {
            // Format the effect part of the rule
            const eff = `mult=${r.effect.multiplier ?? 1} add=${r.effect.additive ?? 0}`;
            
            // Format the condition part of the rule based on its conditioned_axis
            if (r.conditioned_axis === SCORING_AXIS.STACK_COUNT) {
                const pred = [
                    r.predicate.equals !== undefined ? `equals=${r.predicate.equals}` : null,
                    r.predicate.min    !== undefined ? `min=${r.predicate.min}`       : null,
                    r.predicate.max    !== undefined ? `max=${r.predicate.max}`       : null,
                ].filter(Boolean).join(",");
                return `  [${r.id}] stack_count(${pred}) → ${eff}`;
            }
            
            // For delivery_tile rules, include the tile coordinates
            if (r.conditioned_axis === SCORING_AXIS.DELIVERY_TILE)
                return `  [${r.id}] delivery_tile(${r.tile.x},${r.tile.y}) → ${eff}`;
            
            // For parcel_value rules, include the reward range
            const pred = [
                r.predicate.minReward !== undefined ? `min=${r.predicate.minReward}` : null,
                r.predicate.maxReward !== undefined ? `max=${r.predicate.maxReward}` : null,
            ].filter(Boolean).join(",");
            return `  [${r.id}] parcel_value(${pred}) → ${eff}`;
        });
        return `Active scoring rules:\n${ruleLines.join("\n")}`;
    }

    /**
     * Returns true if any stack_count rule would increase reward (multiplier > 1 or additive > 0).
     */
    hasPositiveStackRule(): boolean {
        return this.rules.some(
            r => r.conditioned_axis === SCORING_AXIS.STACK_COUNT &&
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
            .filter((r): r is Extract<ScoringRule, { conditioned_axis: typeof SCORING_AXIS.STACK_COUNT }> =>
                r.conditioned_axis === SCORING_AXIS.STACK_COUNT && this.matchesCarriedParcelCount(r.predicate, carriedCount))
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
            .filter((r): r is Extract<ScoringRule, { conditioned_axis: typeof SCORING_AXIS.DELIVERY_TILE }> =>
                r.conditioned_axis === SCORING_AXIS.DELIVERY_TILE && posKey(r.tile) === key)
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
            .filter((r): r is Extract<ScoringRule, { conditioned_axis: typeof SCORING_AXIS.PARCEL_VALUE }> =>
                r.conditioned_axis === SCORING_AXIS.PARCEL_VALUE && this.matchesParcelValue(r.predicate, reward))
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
