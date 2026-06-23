import type { Beliefs } from "../agents/bdi/belief/beliefs.js";
import type { RuleStore } from "../agents/bdi/desire/rule_store.js";
import type { Negotiator } from "../agents/coordination/negotiator.js";
import type { PeerInbox } from "../agents/coordination/peer_inbox.js";
import type { InjectedDesire, DesireType } from "./desires.js";
import type { GameStrategy } from "./game_strategy.js";

/**
 * The control surface a slow strategic layer (e.g. the LLM agent) uses to observe
 * and steer a BDI agent. The reactive perceive→deliberate→execute loop is NOT part
 * of this port: external code may only read beliefs and nudge the agent via injected
 * desires, scoring rules, game strategies, and handoff arming.
 *
 * `BDIAgent.control()` returns one of these instead of exposing a getter or
 * pass-through method per subsystem.
 */
export interface AgentControl {
    /** Read-only snapshot of current beliefs (updated in place by socket listeners). */
    readonly beliefs: Readonly<Beliefs>;
    /** Scoring-rule store for LLM-injected parcel-scoring rules. */
    readonly ruleStore: RuleStore;
    /** Coordination negotiator for two-phase proposals (rendezvous / red-light / goto). */
    readonly negotiator: Negotiator;
    /** Inbox of peer reports/votes, consumed by the cooperation loop. */
    readonly peerInbox: PeerInbox;

    /** Inject a desire that persists across cycles until it expires. */
    addInjectedDesire(entry: InjectedDesire): void;
    /** Revoke all injected desires of a given type. */
    removeInjectedDesiresByType(type: DesireType["type"]): void;
    /** Set the active cooperation strategy. */
    setGameStrategy(strategy: GameStrategy): void;
    /** Read the active cooperation strategy, or null if none. */
    getGameStrategy(): GameStrategy | null;
    /** Arm the handoff initiator (OPPORTUNISTIC strategy). */
    armHandoff(bonus: number | undefined, ttlMs: number): void;
    /** Disarm the handoff initiator. */
    disarmHandoff(): void;
}
