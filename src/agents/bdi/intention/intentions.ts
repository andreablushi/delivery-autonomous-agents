import type { Beliefs } from "../belief/beliefs.js";
import type { RuleStore } from "../desire/rule_store.js";
import type { DesireType, HoldTileDesire } from "../../../models/desires.js";
import type { GameStrategy } from "../../../models/game_strategy.js";
import { manhattanDistance } from "../../../utils/metrics.js";
import type { IntentionQueue, InjectedIntention } from "../../../models/intentions.js";
import { getIntentionQueue } from "../desire/desire_sorter.js";
import { generateDesires } from "../desire/desire_generator.js";
import { createLogger, type Logger } from "../../../utils/logger.js";

/**
 * Manages the agent's intention queue — an ordered list of desires to pursue,
 * rebuilt each deliberation cycle.
 * The head of the queue is the active intention, which the executor attempts to plan and act on.
 */
export class Intentions {
    // List of candidate intentions, ordered by priority and score, with the head at index 0.
    private intentionsQueue: IntentionQueue = [];
    // List of injected intentions from external sources (e.g. LLM, peer agents) that should be merged into the generated desires each cycle, with expiration.
    private injectedIntentions: InjectedIntention[] = [];
    // Active cooperation directive assigned by the coordination LLM. At most one; pruned by TTL.
    private currentStrategy: GameStrategy | null = null;
    private readonly desireLog: Logger;
    private readonly log: Logger;

    constructor(agentId?: string) {
        this.desireLog = createLogger("desire", agentId);
        this.log = createLogger("intention", agentId);
    }

    /**
     * Adds an injected intention that will be included in the intention queue each cycle until it expires.
        * @param entry The injected intention entry, including the desire itself and an optional expiration time.
     */
    addInjectedIntention(entry: InjectedIntention): void {
        // Remove any existing entry for the same desire (by type and target) to avoid duplicates, then add the new one.
        this.injectedIntentions = this.injectedIntentions.filter(
            e => !(e.desire.type === entry.desire.type &&
                   e.desire.target.x === entry.desire.target.x &&
                   e.desire.target.y === entry.desire.target.y)
        );
        this.injectedIntentions.push(entry);
    }

    /** Set the active cooperation strategy. POSITIONING desires are regenerated each cycle, so
     *  there is no injected state to clean up here. */
    setGameStrategy(strategy: GameStrategy): void {
        this.currentStrategy = strategy;
        this.log.debug(`Game strategy set: ${strategy.strategy}/${strategy.role}` +
            (strategy.partnerId ? ` partner=${strategy.partnerId}` : ""));
    }

    /** Returns the active cooperation strategy, or null if none. */
    getGameStrategy(): GameStrategy | null {
        return this.currentStrategy;
    }

    /** Clear the active cooperation strategy. */
    clearGameStrategy(): void {
        this.currentStrategy = null;
    }

    /**
     * Removes expired injected intentions from the list.
     * Should be called at the start of each deliberation cycle before rebuilding the intention queue.
     */
    private pruneInjectedIntentions(): void {
        const now = Date.now();
        this.injectedIntentions = this.injectedIntentions.filter(e => e.expiresAt === undefined || e.expiresAt > now);
    }

    /** Drop the active strategy once its TTL has elapsed, returning the agent to autonomous behaviour. */
    private pruneStrategy(): void {
        if (this.currentStrategy?.expiresAt !== undefined && this.currentStrategy.expiresAt <= Date.now()) {
            this.log.debug(`Game strategy expired: ${this.currentStrategy.strategy}/${this.currentStrategy.role}`);
            this.currentStrategy = null;
        }
    }

    /**
     * Drop any injected intentions that are already satisfied in the current beliefs to avoid
     * cluttering the intention queue with irrelevant desires.
     * @param beliefs Current beliefs, used to check if any injected intentions are already satisfied (e.g. REACH_TILE where the agent is already on the target tile).
     * @returns void
     */
    private pruneSatisfiedInjectedIntentions(beliefs: Beliefs): void {
        const pos = beliefs.agents.getCurrentPosition();
        if (!pos) return;
        const before = this.injectedIntentions.length;
        this.injectedIntentions = this.injectedIntentions.filter(e => {
            if (e.desire.type === "REACH_TILE") {
                return !(e.desire.target.x === pos.x && e.desire.target.y === pos.y);
            }
            if (e.desire.type === "HOLD_TILE") {
                const d = e.desire as HoldTileDesire;
                // Handshake holds are exclusively managed by HandshakeManager — skip auto-prune.
                if (e.sourceId === "handshake") return true;
                if (!d.releaseZone) return true; // indefinite hold (red light) — only TTL / resume clears it
                const z = d.releaseZone;
                const inZone = (p: { x: number; y: number }) => manhattanDistance(p, z.center) <= z.maxDistance;
                const friends = beliefs.agents.getCurrentFriends().filter(f => f.lastPosition !== null);
                const allInside = inZone(pos) && friends.every(f => inZone(f.lastPosition!));
                return !allInside; // drop when everyone is in zone
            }
            if (e.desire.type === "DELIVER_PARCEL") {
                // Injected midpoint-drop (the handover): once nothing is carried, the drop is done — clear it.
                const me = beliefs.agents.getCurrentMe();
                const stillCarrying = me ? beliefs.parcels.getCarriedByAgent(me.id).length > 0 : true;
                return stillCarrying;
            }
            return true;
        });
        if (this.injectedIntentions.length !== before) {
            this.log.debug(`Pruned satisfied injected intentions (${before} → ${this.injectedIntentions.length})`);
        }
    }

    /** Remove all injected intentions of the given desire type. Used by request_resume. */
    removeIntentionsByType(type: DesireType["type"]): void {
        this.injectedIntentions = this.injectedIntentions.filter(e => e.desire.type !== type);
    }

    /** Remove all injected intentions matching `predicate`. Used by HandshakeManager. */
    removeInjectedIntentions(predicate: (e: InjectedIntention) => boolean): void {
        this.injectedIntentions = this.injectedIntentions.filter(e => !predicate(e));
    }

    /**
     * Rebuild the intention queue from current beliefs, live injected intentions, and active scoring rules.
     * @param beliefs Current beliefs, used by the generator and sorter.
     * @param ruleStore Active scoring rules, forwarded to the generator (for pre-filtering) and sorter (for scoring).
     */
    update(beliefs: Beliefs, ruleStore: RuleStore): void {
        this.pruneStrategy();
        this.pruneInjectedIntentions();
        this.pruneSatisfiedInjectedIntentions(beliefs);
        const desires = generateDesires(beliefs, this.injectedIntentions, this.currentStrategy);

        this.desireLog.debug(
            `Desires generated — ${[...desires.entries()].map(([type, list]) => `${type}:${list.length}`).join(", ") || "none"}`
        );

        if (desires.size === 0) {
            this.intentionsQueue = [];
            this.log.debug("Queue cleared (no desires)");
            return;
        }

        // POSITIONING/PICKUP_AGENT: use pickupZoneCenter when set; otherwise tiles[0].
        const zoneCenter = this.currentStrategy?.pickupZoneCenter ?? this.currentStrategy?.tiles[0];
        const zone = (zoneCenter && this.currentStrategy)
            ? { center: zoneCenter, maxDistance: this.currentStrategy.maxDistance }
            : null;
        this.intentionsQueue = getIntentionQueue(desires, beliefs, ruleStore, zone);
        const head = this.intentionsQueue[0];
        this.log.debug(
            `Queue rebuilt (${this.intentionsQueue.length} items)` +
            (head ? ` — head: ${head.desire.type} @(${head.desire.target.x},${head.desire.target.y}) score=${head.score.toFixed(2)}` : "")
        );
    }

    /**
     * Drop the head of the queue after a plan completes or is unrecoverable.
     */
    dropIntentionHead(): void {
        const dropped = this.intentionsQueue.shift();
        if (dropped) this.log.debug(`Dropped head: ${dropped.desire.type} @(${dropped.desire.target.x},${dropped.desire.target.y})`);
    }

    /**
     * Returns the head intention, or null if the queue is empty.
     */
    getIntentionHead(): IntentionQueue[0] | null {
        return this.intentionsQueue.length > 0 ? this.intentionsQueue[0] : null;
    }

    /**
     * Returns true if `desire` is present in the current intention queue (by reference).
     * @param desire The desire to search for.
     */
    hasIntention(desire: DesireType): boolean {
        return this.intentionsQueue.some((intention) => intention.desire === desire);
    }
}
