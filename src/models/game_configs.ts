/** Settings for the game environment */
export type GameSettings = {
    clock: number;                         // Server game-tick duration in milliseconds (from IOConfig.CLOCK)
}

/** Settings for parcel behavior */
export type ParcelSettings = {
    parcel_spawn_interval: number;         // Interval before new parcels spawn
    reward_decay_interval: number;         // Interval before parcel rewards decay
    reward_avg: number;                    // Average reward for parcels
}

/** Settings for player behavior */
export type PlayerSettings = {
    movement_duration: number;             // Duration of player movement actions
    observation_distance: number;          // Distance within which players can observe parcels (Manhattan)
    carry_capacity: number;                // Maximum number of parcels a player can carry
}