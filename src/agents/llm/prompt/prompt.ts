import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { RuleStore } from "../../bdi/belief/rule_store.js";

const PROMPT_DIR = dirname(fileURLToPath(import.meta.url));
const cache = new Map<string, string>();

function renderTemplate(name: string, vars: Record<string, string>): string {
    if (!cache.has(name)) {
        cache.set(name, readFileSync(join(PROMPT_DIR, `${name}.txt`), "utf-8"));
    }
    return cache.get(name)!.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        if (!(key in vars)) throw new Error(`Template "${name}.txt" has unknown placeholder: {{${key}}}`);
        return vars[key];
    });
}

export function buildSystemPrompt(): string {
    return renderTemplate("system", {});
}

export function buildUserMessage(args: {
    senderName: string;
    senderId: string;
    content: string;
    context: string;
}): string {
    return renderTemplate("user_message", args);
}

export function summarizeBeliefs(beliefs: Readonly<Beliefs>, ruleStore: RuleStore): string {
    const map = beliefs.map.getMap();
    const me = beliefs.agents.getCurrentMe();
    const deliveryTiles = beliefs.map.getDeliveryTiles();
    const carried = me ? beliefs.parcels.getCarriedByAgent(me.id) : [];

    const parts: string[] = [];
    if (map) parts.push(`Map size: ${map.width}x${map.height}`);
    if (me?.lastPosition) parts.push(`My position: (${me.lastPosition.x}, ${me.lastPosition.y})`);
    parts.push(`Carrying: ${carried.length} parcel${carried.length !== 1 ? "s" : ""}${carried.length > 0 ? ` (ids: ${carried.map(p => p.id).join(", ")})` : ""}`);
    if (deliveryTiles.length > 0)
        parts.push(`Delivery tiles: ${deliveryTiles.map(t => `(${t.x},${t.y})`).join(" ")}`);

    const rules = ruleStore.list();
    if (rules.length > 0) {
        const ruleLines = rules.map(r => {
            const eff = `mult=${r.effect.multiplier ?? 1} add=${r.effect.additive ?? 0}`;
            if (r.conditioned_axis === "stack_count") {
                const pred = [r.predicate.equals !== undefined ? `equals=${r.predicate.equals}` : null, r.predicate.min !== undefined ? `min=${r.predicate.min}` : null, r.predicate.max !== undefined ? `max=${r.predicate.max}` : null].filter(Boolean).join(",");
                return `  [${r.id}] stack_count(${pred}) → ${eff}`;
            }
            if (r.conditioned_axis === "delivery_tile") return `  [${r.id}] delivery_tile(${r.tile.x},${r.tile.y}) → ${eff}`;
            const pred = [r.predicate.minReward !== undefined ? `min=${r.predicate.minReward}` : null, r.predicate.maxReward !== undefined ? `max=${r.predicate.maxReward}` : null].filter(Boolean).join(",");
            return `  [${r.id}] parcel_value(${pred}) → ${eff}`;
        });
        parts.push(`Active scoring rules:\n${ruleLines.join("\n")}`);
    }

    const penalties = beliefs.map.listTilePenalties();
    if (penalties.length > 0) {
        const penaltyLines = penalties.map(p => `  [${p.id}] tile(${p.tile.x},${p.tile.y}) cost=${p.cost}`);
        parts.push(`Active traversal penalties:\n${penaltyLines.join("\n")}`);
    }

    return parts.join("\n");
}
