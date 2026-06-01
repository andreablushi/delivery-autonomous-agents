import { TileType } from "./tile_type.js";
import { Position } from "./position.js";

export type IOAgent = {
    id: string;           // Unique identifier for the agent
    name: string;         // Display name of the agent
    teamId: string;       // Identifier of the team the agent belongs to
    teamName: string;     // Display name of the agent's team
    x: number;           // Agent's current column position on the map (optional if not yet placed)
    y: number;           // Agent's current row position on the map (optional if not yet placed)
    score: number;        // Agent's accumulated score
    penalty: number;      // Penalty points accumulated by the agent
}

export type IOParcel = {
    id: string;           // Unique identifier for the parcel
    x: number;            // Parcel's column position on the map
    y: number;            // Parcel's row position on the map
    carriedBy?: string;   // ID of the agent currently carrying the parcel (optional if on the ground)
    reward: number;       // Current reward value of the parcel (decays over time)
}

export type IOCrate = {
    id: string;           // Unique identifier for the delivery crate (drop-off point)
    x: number;            // Crate's column position on the map
    y: number;            // Crate's row position on the map
}

export type IOTile = {
    x: number;            // Tile's column index on the map
    y: number;            // Tile's row index on the map
    type: TileType;       // Tile type code indicating the nature of the tile
}

export type IOMap = {
    width: number;        // Number of columns in the map grid
    height: number;       // Number of rows in the map grid
    tiles: IOTile[];      // Array of all tiles composing the map
}

// Possible clock events that can be emitted by the 
export type IOClockEvent = 'frame' | '1s' | '2s' | '5s' | '10s' | 'infinite';


export type IONpc = {
    moving_event: IOClockEvent,   // How often the NPC moves
    type: string,                 // NPC behaviour type (e.g. 'random', 'collector')
    count: number,                // Number of NPCs of this type
    capacity: number,             // Parcel capacity (for collector NPCs)
};

export type IOConfig = {
    CLOCK: number,                  // Game tick duration in milliseconds
    PENALTY: number,                // Penalty applied for rule violations
    AGENT_TIMEOUT: number,          // Milliseconds before an unresponsive agent is timed out
    BROADCAST_LOGS: boolean,        // Whether server logs are broadcast to all clients
    GAME: {
        title: string,              // Title of the current game session
        description: string,        // Human-readable description of the game scenario
        maxPlayers: number,         // Maximum number of players allowed in the session
        map: { width: number, height: number, tiles: IOTile[] },  // Map geometry and tile layout for the game
        npcs: IONpc[],              // NPC configurations present in the game
        parcels: {
            generation_event: IOClockEvent,   // Event name/interval controlling parcel spawning
            decaying_event: IOClockEvent,     // Event name/interval controlling reward decay
            max: number,                // Maximum number of parcels active at once
            reward_avg: number,         // Mean reward value for newly spawned parcels
            reward_variance: number     // Variance around the mean parcel reward
        },
        player: {
            movement_duration: number,      // Milliseconds a move action takes
            observation_distance: number,   // Manhattan-distance radius within which tiles/agents are visible
            capacity: number                // Maximum number of parcels a player can carry simultaneously
        }
    }
}

export type IOSensing = {
    positions: Position[];                   // Array of tile positions currently visible to the agent
    agents: IOAgent[];                       // Other agents visible within the agent's observation range
    parcels: IOParcel[];                     // Parcels visible within the agent's observation range
    crates: IOCrate[];                       // Delivery crates visible within the agent's observation range
}

export type IOInfo = {
    ms: number;         // Server wall-clock time in milliseconds at this frame
    frame: number;      // Current game frame number
    fps: number;        // Server frames-per-second at the time of this event
    heapUsed: number;   // Node.js heap memory currently in use (bytes)
    heapTotal: number;  // Total Node.js heap memory allocated (bytes)
}

export type IOLogMeta = {
    src: 'server' | 'client';  // Origin of the log message
    ms: number;                 // Timestamp of the log event in milliseconds
    frame: number;              // Game frame at which the log was emitted
    socket: string;             // Socket ID associated with the log source
    id: string;                 // Agent ID associated with the log source
    name: string;               // Agent name associated with the log source
}
