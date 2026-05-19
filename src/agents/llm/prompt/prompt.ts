import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { Beliefs } from "../../bdi/belief/beliefs.js";

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

export function summarizeBeliefs(beliefs: Readonly<Beliefs>): string {
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
    return parts.join("\n");
}
