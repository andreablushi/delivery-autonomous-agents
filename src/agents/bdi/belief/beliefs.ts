import type { IOClockEvent, IOConfig } from "../../../models/djs.js";
import type { GameSettings } from "../../../models/config.js";
import { AgentBeliefs } from "./agent_beliefs.js";
import { MapBeliefs } from "./map_beliefs.js";
import { ParcelBeliefs } from "./parcel_beliefs.js";

/**
 * Converts an IOClockEvent string to milliseconds.
 * Valid values: 'frame' | '1s' | '2s' | '5s' | '10s' | 'infinite'
 * @param event The clock event string from the config
 * @returns The corresponding time interval in milliseconds
 * @throws Error if the event string is not recognized
 */
function parseTimeInterval(event: IOClockEvent): number {
    if (event === "infinite") return Number.POSITIVE_INFINITY;
    if (event === "frame") return 0;
    const match = event.match(/^(\d+)s$/);
    if (!match){
        console.warn(`Unrecognized time interval format: "${event}". Defaulting to 1 second.`);
        return 1_000; // Default to 1 second if unrecognized format
    } 
    return Number(match[1]) * 1_000;
}

/**
 * The Beliefs class serves as the central repository for all beliefs held by the BDI agent
 */
export class Beliefs {
    // Belief sub-systems
    readonly agents  = new AgentBeliefs();   // Tracks me, friends, and enemies
    readonly map: MapBeliefs;                // Tracks map layout and crates
    readonly parcels = new ParcelBeliefs();  // Tracks parcels and their statuses

    // Centralized game settings distributed to sub-systems on arrival
    settings: GameSettings | null = null;

    constructor(agentId?: string) {
        this.map = new MapBeliefs(agentId);
    }

    /**
     * Set game configuration and distribute relevant slices to each sub-system.
     * @param config Raw config from the server
     * @returns void
     */
    setSettings(config: IOConfig): void {
        this.settings = {
            title: config.GAME.title,
            description: config.GAME.description,
            max_player: config.GAME.maxPlayers,
            clock: config.CLOCK,
        };
        // Distribute relevant config slices to sub-systems
        this.agents.setSettings({
            movement_duration: config.GAME.player.movement_duration,
            observation_distance: config.GAME.player.observation_distance,
            carry_capacity: config.GAME.player.capacity,
        });
        this.parcels.setSettings({
                parcel_spawn_interval: parseTimeInterval(config.GAME.parcels.generation_event),
                reward_decay_interval: parseTimeInterval(config.GAME.parcels.decaying_event),
                max_concurrent_parcels: config.GAME.parcels.max,
                reward_avg: config.GAME.parcels.reward_avg,
                reward_variance: config.GAME.parcels.reward_variance,
        })
    }
}
