import type { Agent } from "../../../models/agent.js";
import type { PlayerSettings } from "../../../models/config.js";
import type { IOAgent } from "../../../models/djs.js";
import { Position } from "../../../models/position.js";
import { isHalfPosition } from "../../../utils/metrics.js";
import { Memory } from "./utils/memory.js";
import { Tracker } from "./utils/tracker.js";
import { predictAgentNextPosition } from "./utils/enemy_predictor.js";

/**
 * Beliefs about the agent itself and other observed agents.
 */
export class AgentBeliefs {

    private me: Agent | null = null;                        // Current self-belief, updated directly from observations, without memory
    private friends = new Tracker<Agent>();                 // Tracker of friend agents, keyed by ID, without memory
    private enemies = new Tracker<Agent>(true);             // Tracker of enemy agents, keyed by ID, keeping only the latest observation for each enemy, without memory, keeping half positions
    private enemiesMemory = new Memory<Agent>(1_000, 20);   // Memory of enemy agents, keyed by ID, with TTL-based eviction
    private playerSettings: PlayerSettings | null = null;   // Player settings from config

    private readonly POSITION_STALE_THRESHOLD_MS = 2_000;   // Discard agent positions not refreshed within this window to avoid blocking on ghost agents
    private static readonly HEAT_SIGMA = 3;                 // Spatial spread (tiles): controls how far an enemy's presence radiates
    private static readonly HEAT_TAU   = 5_000;             // Time decay constant (ms): matches enemiesMemory TTL

    // Memory management - EvictInterval prevents the agent from evicting stale beliefs too frequently,
    private lastEvict = 0;                          // Timestamp of the last eviction of stale beliefs
    private readonly EVICT_INTERVAL = 1_000;        // Number of milliseconds between evictions of stale beliefs

    /**
     * Update player settings belief with the latest config info.
     * @param settings 
     * @returns void
     */
    setSettings(settings: PlayerSettings): void {
        this.playerSettings = settings;
    }

    getSettings(): PlayerSettings | null {
        return this.playerSettings;
    }

    /**
     * Update self-belief with the latest info.
     * @param sensedMe Latest info about the agent from the server.
     */
    updateMe(sensedMe: IOAgent): void {
        // Ignore half position
        if (isHalfPosition(sensedMe)) return;
        this.me = {
            id: sensedMe.id,
            name: sensedMe.name,
            teamName: sensedMe.teamName,
            score: sensedMe.score,
            penalty: sensedMe.penalty,
            lastPosition: { x: sensedMe.x, y: sensedMe.y },
        };
    }

    /**
     * Optimistically update the believed position of this agent after a successful movement ack.
     * @param position The acknowledged destination tile.
     */
    updateMyPosition(position: Position): void {
        if (!this.me) return;
        this.me = {
            ...this.me,
            lastPosition: { x: position.x, y: position.y },
        };
    }

    /**
     * Update beliefs about other agents based on the latest observations.
     * @param sensedAgents List of all observed agents from the latest observation, used to update beliefs about friends and enemies.
     */
    updateOtherAgents(sensedAgents: IOAgent[], sensedPositions: Position[]): void {
        sensedAgents.forEach(agent => {
            const data: Agent = {
                id: agent.id,
                name: agent.name,
                teamName: agent.teamName,
                score: agent.score,
                penalty: agent.penalty ?? 0,
                lastPosition: (agent.x != null && agent.y != null) ? { x: agent.x, y: agent.y } : null,
            };
            if (agent.teamName && agent.teamName === this.me?.teamName) {
                this.friends.update(agent.id, data);
            } else {
                this.enemies.update(agent.id, data);
                this.enemiesMemory.update(agent.id, data);
            }
        });

        // Invalidate lastPosition for enemies not currently visible but whose last known position is in view
        this.enemies.invalidateAtSensedPositions(sensedAgents, sensedPositions);
        this.friends.invalidateAtSensedPositions(sensedAgents, sensedPositions);

        // Evict stale beliefs that haven't been updated recently to prevent memory bloat. This is done after processing the current observations to ensure we don't evict beliefs that were just updated.
        this.evict();
    }

    /**
     * Get the current believed state of the agent itself.
     * @returns The current self-belief, or null if not yet observed.
     */
    getCurrentMe(): Agent | null {
        return this.me;
    }

    /**
     * Get the agent's current tile position. Always integer-valued — half positions are
     * rejected by updateMe before being stored.
     * @returns The current position, or null if not yet observed.
     */
    getCurrentPosition(): Position | null {
        return this.me?.lastPosition ?? null;
    }

    /**
     * Get the observation distance from the player settings.
     * @returns The observation distance in tiles, or null if settings are not yet received.
     */
    getObservationDistance(): number | null {
        return this.playerSettings?.observation_distance ?? null;
    }

    /**
     * Get the list of all currently believed friend agents
     * @returns An array of friend agents
     */
    getCurrentFriends(): Agent[] {
        return this.friends.getCurrentAll();
    }

    /**
     * Refresh the believed position of a friend from a direct peer message.
     * @param id Friend agent id
     * @param position Latest believed position for that friend
     */
    updateFriendPosition(id: string, position: Position): void {
        const friend = this.friends.getCurrentAll().find(agent => agent.id === id);
        if (!friend) return;
        this.friends.updateValuePreservingTimestamp(id, { ...friend, lastPosition: position });
    }
    
    /**
     * Get the list of all currently believed enemy agents
     * @returns An array of enemy agents
     */
    getCurrentEnemies(): Agent[] {
        return this.enemies.getCurrentAll();
    }

    /**
     * Returns true when the next tile is currently occupied by an observed enemy
     * or when a confident prediction indicates an enemy will step into it.
     * @param next The next tile of our current path
     * @param isWalkable Optional callback used to filter impossible predictions
     */
    isNextBlockedByAgents(next: Position, isWalkable?: (from: Position, to: Position) => boolean): boolean {
        // Only consider agents whose last known position was observed recently — stale positions
        // belong to agents that left our sensing range and may no longer be at that tile.
        const now = Date.now();
        const freshAgents = (list: Agent[], tracker: Tracker<Agent>) =>
            list.filter(a => {
                const ts = tracker.getLastTimestamp(a.id);
                return ts !== undefined && (now - ts) <= this.POSITION_STALE_THRESHOLD_MS;
            });
        const agents = [
            ...freshAgents(this.getCurrentEnemies(), this.enemies),
            ...freshAgents(this.getCurrentFriends(), this.friends),
        ];

        // Check if any currently observed enemy is on the next tile, considering half positions as well
        for (const agent of agents) {
            const pos = agent.lastPosition;
            if (!pos) continue;

            // Retrieve the last known position of the agent and if it's not an integer coordinate, it means the agent is in between two tiles
            const xs = Number.isInteger(pos.x) ? [pos.x] : [Math.floor(pos.x), Math.ceil(pos.x)];
            const ys = Number.isInteger(pos.y) ? [pos.y] : [Math.floor(pos.y), Math.ceil(pos.y)];

            // If the next tile is one of the tiles corresponding to the agent's last known position (including half positions), consider it blocked
            if (xs.includes(next.x) && ys.includes(next.y)) {
                return true;
            }

            // Retrieve a prediction for the agent's next position based on its movement history
            const predicted = predictAgentNextPosition(agent, this.enemiesMemory.getHistory(agent.id), isWalkable);

            // If the predicted next position of the enemy has a confidence of 0.5 or higher and matches the next tile, consider it blocked
            if (
                predicted &&
                predicted.confidence >= 0.5 &&
                predicted.position.x === next.x &&
                predicted.position.y === next.y
            ) {
                return true;
            }
        }

        // Otherwise, consider the next tile unblocked by enemies
        return false;
    }

    /**
     * Get the confidence level of the belief about a specific enemy agent
     * @param id Enemy agent ID
     * @returns Confidence score between 0 and 1
     */
    getEnemyConfidence(id: string): number | undefined {
        return this.enemies.getConfidence(id, 2000);
    }

    /**
     * Get the carry capacity from the player settings.
     * @returns The carry capacity, or null if settings are not yet received.
     */
    getCarryCapacity(): number | null {
        return this.playerSettings?.carry_capacity ?? null;
    }

    /**
     * Heat contribution at `pos` from a single enemy, computed from its observation history.
     * Each observation contributes exp(-d²/2σ²) * exp(-age/τ), combining spatial and temporal decay.
     * @param enemyId The ID of the enemy agent to compute heat for.
     * @param pos The position at which to evaluate the heat.
     * @param now Current timestamp in ms; defaults to Date.now().
     * @returns Total heat contribution from this enemy at pos (0 when no history exists).
     */
    heatFromEnemy(enemyId: string, pos: Position, now = Date.now()): number {
        const history = this.enemiesMemory.getHistory(enemyId);
        let heat = 0;
        for (const obs of history) {
            const ePos = obs.value.lastPosition;
            if (!ePos) continue;
            const d = Math.abs(pos.x - ePos.x) + Math.abs(pos.y - ePos.y);
            const spatialDecay = Math.exp(-(d * d) / (2 * AgentBeliefs.HEAT_SIGMA * AgentBeliefs.HEAT_SIGMA));
            const timeDecay = Math.exp(-(now - obs.seenAt) / AgentBeliefs.HEAT_TAU);
            heat += spatialDecay * timeDecay;
        }
        return heat;
    }

    /**
     * Aggregate enemy heat at `pos` across all currently-tracked enemies.
     * Used by the EXPLORE scorer to penalise spawn tiles near recent enemy positions.
     * @param pos The position at which to evaluate total enemy heat.
     * @returns Sum of per-enemy heat contributions at pos.
     */
    getEnemyHeatAt(pos: Position): number {
        const now = Date.now();
        return this.enemies.getCurrentAll().reduce(
            (sum, enemy) => sum + this.heatFromEnemy(enemy.id, pos, now),
            0
        );
    }

    /**
     * Evict stale beliefs that haven't been updated recently to prevent memory bloat.
     */
    private evict(): void {
        const now = Date.now();
        if (now - this.lastEvict < this.EVICT_INTERVAL) return;
        this.lastEvict = now;
        this.enemiesMemory.evict();
    }
}
