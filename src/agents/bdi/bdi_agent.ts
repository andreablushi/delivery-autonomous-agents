import { IOConfig, IOTile, IOAgent, IOSensing } from "../../models/djs.js";
import type { PersistentDesireEntry } from "../../models/intentions.js";
import { Beliefs } from "./belief/beliefs.js";
import { Intentions } from "./intention/intentions.js";
import { Executor } from "./execution/executor.js";
import { Planner } from "./plan/planner.js";
import { createLogger } from "../../utils/logger.js";

/**
 * BDI Agent — orchestrates the perceive → deliberate → execute cycle.
 *
 * Deliberation is event-driven: each `sensing` event triggers one cycle.
 * PDDL solver results are picked up on the next cycle after the async request resolves.
 */
export class BDIAgent {
    private socket: any;
    private beliefs: Beliefs;
    private planner: Planner;
    private intentions: Intentions;
    private executor: Executor;
    private perceiveLog;
    private deliberateLog;

    constructor(socket: any, agentId?: string) {
        this.socket = socket;
        this.perceiveLog = createLogger("perceive", agentId);
        this.deliberateLog = createLogger("deliberate", agentId);
        this.beliefs = new Beliefs(agentId);
        this.intentions = new Intentions(agentId);
        this.planner = new Planner(this.intentions, this.beliefs, agentId);
        this.executor = new Executor(socket, this.beliefs, this.intentions, this.planner, agentId);

        this.socket.on('config', (config: IOConfig) => {
            this.beliefs.setSettings(config);
            const obsDist = this.beliefs.agents.getObservationDistance();
            if (obsDist !== null) this.beliefs.map.computeClusterWeights(obsDist);
        });

        this.perceive();
    }

    /**
     * Return current beliefs for external inspection (e.g. by an LLM)
     * @returns Beliefs object, which is readonly and updated in-place by socket listeners.
     */
    getBeliefs(): Readonly<Beliefs> {
        return this.beliefs;
    }

    /**
     * Add a persistent desire that will be included in the intention queue each cycle until it expires.
     * Useful for desires injected by an LLM or other external system that should persist across multiple cycles.
     * @param entry The persistent desire entry, including the desire itself and its expiration time.
     */
    addPersistentDesire(entry: PersistentDesireEntry): void {
        this.intentions.addPersistentDesire(entry);
    }

    /**
     * Register socket listeners that update beliefs and drive the deliberation cycle.
     * Each sensing event is one deliberation tick.
     */
    perceive() {
        // Agent's own position and score — fires on every successful move
        this.socket.on('you', (me: IOAgent) => {
            this.beliefs.agents.updateMe(me);
            this.perceiveLog.debug("Me status updated — pos: [", me.x, ", ", me.y, "]| score:", me.score, "]");
        });

        // Static map — sent once at connection
        this.socket.once('map', (width: number, height: number, tiles: IOTile[]) => {
            // Server reports N-1 / M-1 for an NxM map — add 1 to both dimensions.
            this.beliefs.map.updateMap(width + 1, height + 1, tiles);
            const obsDist = this.beliefs.agents.getObservationDistance();
            if (obsDist !== null) this.beliefs.map.computeClusterWeights(obsDist);
            this.perceiveLog.debug("Map info received — width:", width, "| height:", height, "| tiles:", tiles.length);
        });

        // Periodic sensing — agents, parcels, crates; this is the main deliberation trigger
        this.socket.on('sensing', (sensing: IOSensing) => {
            this.beliefs.agents.updateOtherAgents(sensing.agents, sensing.positions);
            this.beliefs.parcels.updateParcels(sensing.parcels, sensing.positions);
            this.beliefs.map.updateCrates(sensing.crates, sensing.positions);
            this.beliefs.map.updateSpawnTilesSensingTimes(sensing.positions, Date.now());

            this.perceiveLog.debug("Sensing update — agents:", sensing.agents.length,
                "| parcels:", sensing.parcels.length, "| crates:", sensing.crates.length);
            this.perceiveLog.debug("Current beliefs state:");
            this.perceiveLog.debug("  - Friends:", this.beliefs.agents.getCurrentFriends().length, "agents");
            this.perceiveLog.debug("  - Enemies:", this.beliefs.agents.getCurrentEnemies().length, "agents");
            this.perceiveLog.debug("  - Parcels:", this.beliefs.parcels.getCurrentParcels().length, "parcels");
            this.perceiveLog.debug("  - Crates:", this.beliefs.map.getCurrentCrates().length, "crates");

            this.deliberate();
        });
    }

    /**
     * One deliberation cycle: rebuild desires → update intention queue → plan → execute one step.
     */
    deliberate(): void {
        this.intentions.update(this.beliefs);
        this.deliberateLog.debug("Intention selected:", this.intentions.getIntentionHead());

        this.executor.start();
    }
}
