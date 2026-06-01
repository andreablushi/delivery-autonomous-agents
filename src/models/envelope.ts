export type PeerInjectionKind =
    | "request_goto"
    | "request_putdown_at"
    | "register_scoring_rule"
    | "register_traversal_penalty"
    | "request_rendezvous"
    | "request_red_light"
    | "request_resume"
    | "request_beliefs"
    | "beliefs_report";

/** Wire format for a peer-injection message. */
export type PeerInjectionEnvelope = {
    v: 1;
    kind: "peer_injection";
    tool: PeerInjectionKind;
    args: Record<string, unknown>;
};

const VALID_TOOLS: ReadonlySet<string> = new Set([
    "request_goto",
    "request_putdown_at",
    "register_scoring_rule",
    "register_traversal_penalty",
    "request_rendezvous",
    "request_red_light",
    "request_resume",
    "request_beliefs",
    "beliefs_report",
]);

/** Serialise an envelope to a JSON string ready for `emitSay`. */
export function encode(envelope: PeerInjectionEnvelope): string {
    return JSON.stringify(envelope);
}

/**
 * Attempt to parse `raw` as a `PeerInjectionEnvelope`.
 * Returns `null` if the value is not a valid JSON envelope.
 */
export function tryDecode(raw: unknown): PeerInjectionEnvelope | null {
    if (typeof raw !== "string") return null;
    try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        if (obj.v !== 1 || obj.kind !== "peer_injection") return null;
        if (typeof obj.tool !== "string" || !VALID_TOOLS.has(obj.tool)) return null;
        if (typeof obj.args !== "object" || obj.args === null) return null;
        return obj as unknown as PeerInjectionEnvelope;
    } catch {
        return null;
    }
}
