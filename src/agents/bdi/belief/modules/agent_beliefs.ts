import type { Agent } from "../../../../models/agent.js";
import type { PlayerSettings } from "../../../../models/game_configs.js";
import type { IOAgent } from "../../../../models/djs.js";
import { Position } from "../../../../models/position.js";
import { isHalfPosition, manhattanDistance } from "../../../../utils/metrics.js";
import { Memory } from "../collections/memory.js";
import { Tracker } from "../collections/tracker.js";
import { predictAgentNextPosition, agentOccupiesTile } from "./utils/enemy_predictor.js";
import { config } from "../../../../config.js";

/**
 * Beliefs about the agent itself and other observed agents.
 */
export class AgentBeliefs {

    // Current self-belief about this agent, updated directly from observations
    private me: Agent | null = null;
    // Trackers of friend agents, keyed by agent ID, without memory
    private friends = new Tracker<Agent>();
    // Trackers of enemy agents, keyed by agent ID, keeping only the last known position
    private enemies = new Tracker<Agent>(true);
    // Memory of enemy agents, keyed by agent ID, with TTL eviction and size limit
    private enemiesMemory = new Memory<Agent>(
        config.beliefs.enemy.memoryTtlMs,
        config.beliefs.enemy.memorySizeEntries
    );
    // List of teammate IDs, used to classify observed agents as friends or enemies and to filter position beacons
    private readonly teammateIds: ReadonlySet<string>;

    private playerSettings: PlayerSettings | null = null;
    private lastEvict = 0;

    constructor(teammateIds: ReadonlySet<string> = new Set()) {
        this.teammateIds = teammateIds;
    }
    
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
            // Classify the agent as a friend or enemy based on whether their ID is in the teammateIds set.
            // Update the corresponding tracker and memory.
            if (this.teammateIds.has(agent.id)) {
                this.friends.update(agent.id, data);
            }
            else {
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
     * Get the set of statically-configured teammate IDs (set at construction time).
     * @returns Readonly set of teammate agent IDs.
     */
    getTeammateIds(): ReadonlySet<string> {
        return this.teammateIds;
    }

    /**
     * Get the list of all currently believed friend agents
     * @returns An array of friend agents
     */
    getCurrentFriends(): Agent[] {
        return this.friends.getCurrentAll();
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
    isNextBlockedByAgents(next_tile: Position, isWalkable?: (from: Position, to: Position) => boolean): boolean {
        // Only consider agents whose last known position was observed recently — stale positions
        // belong to agents that left our sensing range and may no longer be at that tile.
        const now = Date.now();
        // Get the list of fresh agents
        const freshAgents = (list: Agent[], tracker: Tracker<Agent>) =>
            list.filter(agent => {
                const delta_observation = tracker.getLastTimestamp(agent.id);
                return delta_observation !== undefined && (now - delta_observation) <= config.beliefs.positionStaleThresholdMs;
            });
        
        /**
         * Check if the given agent is currently occupying the next tile, either by direct observation or by a confident prediction.
         * @param agent The agent to check
         * @returns True if the agent is believed to be on the next tile, false otherwise
         */
        const checkAgent = (agent: Agent): boolean => {
            // If the agent is currently observed on the next tile, it's an immediate block
            if (agentOccupiesTile(agent, next_tile)) return true;
            // Otherwise, check if a confident prediction indicates the agent will be on the next tile next tick
            const predicted = predictAgentNextPosition(agent, this.enemiesMemory.getHistory(agent.id), isWalkable);
            return (
                predicted !== null &&
                predicted.confidence >= config.beliefs.enemy.confidenceThreshold &&
                predicted.position.x === next_tile.x &&
                predicted.position.y === next_tile.y
            );
        };

        // Enemies are always hard obstacles
        for (const agent of freshAgents(this.getCurrentEnemies(), this.enemies)) {
            if (checkAgent(agent)) return true;
        }

        // Friends use a deterministic yield: the higher-id agent keeps moving while the
        // lower-id one waits, so converging teammates resolve in one tick instead of both
        // blocking, wiping their plans, and replanning indefinitely.
        // Friends are NOT filtered by freshness: the beacon interval equals the stale threshold,
        // so any processing delay would exclude them and break the yield. We conservatively treat
        // a friend's last known position as valid; agentOccupiesTile returns false for null positions.
        const myId = this.getCurrentMe()?.id;
        for (const agent of this.getCurrentFriends()) {
            // If we know our id and it is greater, we yield to this friend — don't block.
            if (myId !== undefined && myId > agent.id) continue;
            if (checkAgent(agent)) return true;
        }
        return false;
    }

    /**
     * Get the confidence level of the belief about a specific enemy agent
     * @param id Enemy agent ID
     * @returns Confidence score between 0 and 1
     */
    getEnemyConfidence(id: string): number | undefined {
        return this.enemies.getConfidence(id, config.beliefs.enemy.confidenceHalfLifeMs);
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
            const d = manhattanDistance(pos, ePos);
            const spatialDecay = Math.exp(-(d * d) / (2 * config.beliefs.enemy.heatSigma * config.beliefs.enemy.heatSigma));
            const timeDecay = Math.exp(-(now - obs.seenAt) / config.beliefs.enemy.heatTau);
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
     * Update a single agent's position from a position beacon.
     * Only updates known teammates (by ID) — beacons from unrecognised agents are
     * ignored to avoid trusting unsolicited position claims from adversaries.
     * teamName is preserved from the existing record (the beacon no longer carries it).
     */
    updateAgentFromBeacon(id: string, name: string, pos: { x: number; y: number } | null): void {
        if (!this.teammateIds.has(id)) return;
        const existing = this.friends.getCurrentAll().find(f => f.id === id);
        const data: Agent = {
            id, name,
            teamName: existing?.teamName ?? "",
            score: existing?.score ?? 0,
            penalty: existing?.penalty ?? 0,
            lastPosition: pos,
        };
        this.friends.update(id, data);
    }

    /** Evict stale beliefs that haven't been updated recently to prevent memory bloat. */
    private evict(): void {
        const now = Date.now();
        if (now - this.lastEvict < config.beliefs.evictIntervalMs) return;
        this.lastEvict = now;
        this.enemiesMemory.evict();
    }
}
