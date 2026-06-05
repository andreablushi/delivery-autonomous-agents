import type { Position } from "./position.js";

/** Named constants for all peer-injection message kinds. Use these instead of raw string literals. */
export const PeerKind = {
    RequestGoto:              "request_goto",
    RequestPutdownAt:         "request_putdown_at",
    RegisterScoringRule:      "register_scoring_rule",
    RegisterTraversalPenalty: "register_traversal_penalty",
    RendezvousPropose:        "rendezvous_propose",
    RendezvousVote:           "rendezvous_vote",
    RendezvousCommit:         "rendezvous_commit",
    RendezvousAbort:          "rendezvous_abort",
    RedLightPropose:          "red_light_propose",
    RedLightVote:             "red_light_vote",
    RedLightCommit:           "red_light_commit",
    RedLightAbort:            "red_light_abort",
    GotoPropose:              "goto_propose",
    GotoVote:                 "goto_vote",
    GotoCommit:               "goto_commit",
    GotoAbort:                "goto_abort",
    RequestResume:            "request_resume",
    RequestBeliefs:           "request_beliefs",
    BeliefsReport:            "beliefs_report",
    PositionBeacon:           "position_beacon",
    AssignStrategy:           "assign_strategy",
} as const;
/** Type representing the valid peer-injection message kinds. */
export type PeerInjectionKind = typeof PeerKind[keyof typeof PeerKind];
/** Set of valid peer-injection message kinds, for quick lookup. */
const VALID_TOOLS: ReadonlySet<string> = new Set(Object.values(PeerKind));

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
