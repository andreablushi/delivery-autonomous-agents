import type { Position } from "./position.js";

/** Types of peer-injection messages. Lists all the possible message types to be sent between peers */
const PEER_INJECTION_KINDS = [
    "request_goto",
    "request_putdown_at",
    "register_scoring_rule",
    "register_traversal_penalty",
    "rendezvous_propose",
    "rendezvous_vote",
    "rendezvous_commit",
    "rendezvous_abort",
    "request_red_light",
    "request_resume",
    "request_beliefs",
    "beliefs_report",
    "position_beacon",
] as const;
/** Type representing the valid peer-injection message kinds. */
export type PeerInjectionKind = typeof PEER_INJECTION_KINDS[number];
/** Set of valid peer-injection message kinds, for quick lookup. */
const VALID_TOOLS: ReadonlySet<string> = new Set(PEER_INJECTION_KINDS);

/** Compact belief snapshot sent by a BDI teammate in response to a request_beliefs message. */
export type BeliefsReport = {
    pos: Position | null;
    carrying: number;
    enemies: Position[];
    hotTiles: { x: number; y: number; heat: number }[];
    nearestDelivery: Position | null;
};

/** Wire format for a peer-injection message. */
export type PeerInjectionMessage =
    | { v: 1; kind: "peer_injection"; tool: "beliefs_report"; args: BeliefsReport }
    | { v: 1; kind: "peer_injection"; tool: Exclude<PeerInjectionKind, "beliefs_report">; args: Record<string, unknown> };

/** Serialise a message to a JSON string ready for `emitSay`. */
export function encode(message: PeerInjectionMessage): string {
    return JSON.stringify(message);
}

/**
 * Attempt to parse `raw` as a `PeerInjectionMessage`.
 * Returns `null` if the value is not a valid JSON message.
 */
export function tryDecode(raw: unknown): PeerInjectionMessage | null {
    if (typeof raw !== "string") return null;
    try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        if (obj.v !== 1 || obj.kind !== "peer_injection") return null;
        if (typeof obj.tool !== "string" || !VALID_TOOLS.has(obj.tool)) return null;
        if (typeof obj.args !== "object" || obj.args === null) return null;
        return obj as unknown as PeerInjectionMessage;
    } catch {
        return null;
    }
}
