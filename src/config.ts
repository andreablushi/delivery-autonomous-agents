/**
 * Central configuration for all tunable parameters.
 * Edit values here to adjust system behaviour — no env vars needed.
 */
export const config = {

    beliefs: {
        positionStaleThresholdMs: 2_000,    // Discard agent positions not refreshed within this window
        evictIntervalMs: 1_000,             // Minimum gap between stale-belief eviction passes
        positionBeaconIntervalMs: 3_000,    // How often each agent broadcasts its own position to teammates
        enemy: {
            memoryTtlMs: 1_000,             // How long an enemy observation stays in memory
            memorySizeEntries: 20,          // Max observations kept per enemy
            heatSigma: 3,                   // Spatial spread (tiles) of the heat Gaussian
            heatTau: 5_000,                 // Time decay constant (ms) of the heat signal
            confidenceThreshold: 0.5,       // Min confidence to treat a predicted enemy position as blocking
            confidenceHalfLifeMs: 2_000,    // Half-life for the enemy tracker confidence score
            predictionCeilThreshold: 0.6,   // Fractional coord above which agent is committed to the upper tile
            predictionFloorThreshold: 0.4,  // Fractional coord below which agent is committed to the lower tile
        },
    },

    navigation: {
        cratePushPenalty: 4,    // Extra A* edge cost for tiles occupied by a crate
    },

    collision: {
        detourThresholdSteps: 5,            // Max extra steps a detour may add before we prefer to wait
        waitMinMs: 1_000,                   // Minimum wait time before escalating a blocked tile
        waitMaxMs: 1_500,                   // Maximum wait time before escalating a blocked tile
        blockedAfterExpirationTtlMs: 2_000, // TTL applied when committing a block after wait expires / detour fails
        invalidationBlockedTtlMs: 1_000,    // TTL applied when committing a block after repeated invalidation
        invalidationRetryLimit: 2,          // Invalidation attempts before marking a tile as blocked
    },

    pddl: {
        waitMinMs: 1_000,   // Minimum wait before re-trying a PDDL plan
        waitMaxMs: 1_500,   // Maximum wait before re-trying a PDDL plan
        blockedTtlMs: 1_000,// TTL for tiles blocked during PDDL planning
        retryLimit: 2,      // Max PDDL planning retries before giving up
        cacheSize: 32,      // Max cached maneuver results
    },

    execution: {
        defaultClockTickMs: 50, // Fallback idle-wait duration when server clock is unknown
    },

    map: {
        defaultBlockedTtlMs: 1_000, // Default TTL for temporarily-blocked tiles (e.g. agent collision)
    },

    llm: {
        maxHops: 5,             // Max consecutive tool-call rounds per LLM invocation
        timeoutMs: 15_000,      // HTTP timeout for OpenAI-compatible API calls
        replyMaxChars: 280,     // Character limit for the reply tool
    },

    coordination: {
        intervalMs: 10_000,     // How often the LLM coordinator runs a team assignment round
        collectWindowMs: 750,   // Time to wait for belief reports before running the LLM pass
        cooldownMs: 5_000,      // Minimum gap between coordination rounds
        hotZonesLimit: 5,       // Max hot zones kept when merging teammate reports
    },

    rendezvous: {
        commitWindowMs: 750,    // Time to wait for peer votes before committing or aborting
    },

    report: {
        hotTilesLimit: 5,   // Max hot tiles included in a single belief report
    },

} as const;
