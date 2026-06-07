import type { Beliefs } from "../belief/beliefs.js";
import type { RuleStore } from "../desire/rule_store.js";
import type { DesireType, HoldTileDesire, DesireQueue, InjectedDesire } from "../../../models/desires.js";
import type { GameStrategy } from "../../../models/game_strategy.js";
import { StrategyType } from "../../../models/game_strategy.js";
import { manhattanDistance } from "../../../utils/metrics.js";
import { rankDesires } from "./desire_ranker.js";
import { generateDesires } from "../desire/desire_generator.js";
import { RoleController } from "../../cooperation/role_controller.js";
import { createLogger, type Logger } from "../../../utils/logger.js";

/**
 * Manages the agent's intention queue — an ordered list of desires to pursue,
 * rebuilt each deliberation cycle.
 * The head of the queue is the active intention, which the executor attempts to plan and act on.
 */
export class Intentions {
    // Ranked desire candidates; the head (index 0) is the committed intention for this cycle.
    private desireQueue: DesireQueue = [];
    // Desires injected by external sources (e.g. LLM, peer agents) merged each cycle, with expiration.
    private injectedDesires: InjectedDesire[] = [];
    // Active cooperation directive assigned by the coordination LLM. At most one; pruned by TTL.
    private currentStrategy: GameStrategy | null = null;
    // Deterministic role state machine for HANDOFF strategies.
    private readonly controller: RoleController;
    private readonly desireLog: Logger;
    private readonly log: Logger;

    constructor(agentId?: string) {
        this.controller = new RoleController(agentId);
        this.desireLog = createLogger("desire", agentId);
        this.log = createLogger("intention", agentId);
    }

    /**
     * Adds an injected desire that will be included in the desire queue each cycle until it expires.
     * @param entry The injected desire entry, including the desire itself and an optional expiration time.
     */
    addInjectedDesire(entry: InjectedDesire): void {
        // Remove any existing entry for the same desire (by type and target) to avoid duplicates, then add the new one.
        this.injectedDesires = this.injectedDesires.filter(
            e => !(e.desire.type === entry.desire.type &&
                   e.desire.target.x === entry.desire.target.x &&
                   e.desire.target.y === entry.desire.target.y)
        );
        this.injectedDesires.push(entry);
    }

    /** Set the active cooperation strategy. The RoleController generates gated desires each cycle. */
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
        this.controller.reset();
    }

    /**
     * Removes expired injected desires from the list.
     * Should be called at the start of each deliberation cycle before rebuilding the desire queue.
     */
    private pruneInjectedDesires(): void {
        const now = Date.now();
        this.injectedDesires = this.injectedDesires.filter(e => e.expiresAt === undefined || e.expiresAt > now);
    }

    /** Drop the active strategy once its TTL has elapsed, returning the agent to autonomous behaviour. */
    private pruneStrategy(): void {
        if (this.currentStrategy?.expiresAt !== undefined && this.currentStrategy.expiresAt <= Date.now()) {
            this.log.debug(`Game strategy expired: ${this.currentStrategy.strategy}/${this.currentStrategy.role}`);
            this.currentStrategy = null;
            this.controller.reset();
        }
    }

    /**
     * Drop any injected desires that are already satisfied in the current beliefs to avoid
     * cluttering the desire queue with irrelevant entries.
     * @param beliefs Current beliefs, used to check if any injected desires are already satisfied.
     */
    private pruneSatisfiedInjectedDesires(beliefs: Beliefs): void {
        const pos = beliefs.agents.getCurrentPosition();
        if (!pos) return;
        const before = this.injectedDesires.length;
        this.injectedDesires = this.injectedDesires.filter(e => {
            if (e.desire.type === "REACH_TILE") {
                return !(e.desire.target.x === pos.x && e.desire.target.y === pos.y);
            }
            if (e.desire.type === "HOLD_TILE") {
                const d = e.desire as HoldTileDesire;
                // Handshake (role) holds are managed externally — skip auto-prune.
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
        if (this.injectedDesires.length !== before) {
            this.log.debug(`Pruned satisfied injected desires (${before} → ${this.injectedDesires.length})`);
        }
    }

    /** Remove all injected desires of the given desire type. Used by request_resume. */
    removeInjectedDesiresByType(type: DesireType["type"]): void {
        this.injectedDesires = this.injectedDesires.filter(e => e.desire.type !== type);
    }

    /**
     * Rebuild the desire queue from current beliefs, live injected desires, and active scoring rules.
     * @param beliefs Current beliefs, used by the generator and ranker.
     * @param ruleStore Active scoring rules, forwarded to the generator (for pre-filtering) and ranker (for scoring).
     */
    update(beliefs: Beliefs, ruleStore: RuleStore): void {
        this.pruneStrategy();
        this.pruneInjectedDesires();
        this.pruneSatisfiedInjectedDesires(beliefs);

        // Capture the previous cycle's HOLD_TILE target for hysteresis in the scorer.
        const prevHead = this.desireQueue[0];
        const prevHoldTarget = prevHead?.desire.type === "HOLD_TILE" ? prevHead.desire.target : undefined;

        const strategy = this.currentStrategy;

        // If we are currently executing a cooperation strategy that requires role-based gating,
        // delegate desire generation to the RoleController, ignoring the autonomous path for this cycle
        if (strategy?.strategy === StrategyType.ZonalRelay || strategy?.strategy === StrategyType.Opportunistic) {
            this.controller.sync(strategy);
            this.controller.tick(beliefs, strategy);

            // If the strategy is complete, clear it and return to autonomous behaviour
            if (this.controller.isComplete(strategy)) {
                this.log.debug(`Role FSM complete (${strategy.role}) — clearing strategy`);
                this.clearGameStrategy();
            }
            // Otherwise, build the desire queue from the controller's gated desires
            else {
                const desires = this.controller.buildDesires(beliefs, strategy);
                this.desireLog.debug(
                    `Role desires (${strategy.role}) — ` +
                    ([...desires.entries()].map(([type, list]) => `${type}:${list.length}`).join(", ") || "none")
                );

                this.desireQueue = rankDesires(desires, beliefs, ruleStore, null, prevHoldTarget);
                const head = this.desireQueue[0];
                this.log.debug(
                    `Queue rebuilt (${this.desireQueue.length} items, role=${strategy.role})` +
                    (head ? ` — head: ${head.desire.type} @(${head.desire.target.x},${head.desire.target.y}) score=${head.score.toFixed(2)}` : "")
                );
                return;
            }
        }
        // Autonomous path: use belief-derived desires plus injected desires.
        const desires = generateDesires(beliefs, this.injectedDesires);
        this.desireLog.debug(
            `Desires generated — ${[...desires.entries()].map(([type, list]) => `${type}:${list.length}`).join(", ") || "none"}`
        );

        if (desires.size === 0) {
            this.desireQueue = [];
            this.log.debug("Queue cleared (no desires)");
            return;
        }
        // Rank desires into the desire queue; head is the committed intention for this cycle
        this.desireQueue = rankDesires(desires, beliefs, ruleStore, null, prevHoldTarget);
        const head = this.desireQueue[0];
        this.log.debug(
            `Queue rebuilt (${this.desireQueue.length} items)` +
            (head ? ` — head: ${head.desire.type} @(${head.desire.target.x},${head.desire.target.y}) score=${head.score.toFixed(2)}` : "")
        );
    }

    /**
     * Drop the head of the queue after a plan completes or is unrecoverable.
     */
    dropIntentionHead(): void {
        const dropped = this.desireQueue.shift();
        if (dropped) this.log.debug(`Dropped head: ${dropped.desire.type} @(${dropped.desire.target.x},${dropped.desire.target.y})`);
    }

    /**
     * Returns the head intention, or null if the queue is empty.
     */
    getIntentionHead(): DesireQueue[0] | null {
        return this.desireQueue.length > 0 ? this.desireQueue[0] : null;
    }

}
