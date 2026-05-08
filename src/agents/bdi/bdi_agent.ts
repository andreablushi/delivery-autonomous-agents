import { IOConfig, IOTile, IOAgent, IOSensing } from "../../models/djs.js";
import { Beliefs } from "./belief/beliefs.js";
import { generateDesires } from "./desire/desire_generator.js";
import { Intentions } from "./intention/intentions.js";
import { Executor } from "./execution/executor.js";
import { Planner } from "./plan/planner.js";

/**
 * BDI Agent — orchestrates the perceive → deliberate → execute cycle.
 *
 * Deliberation is event-driven: `sensing` events from the server trigger each cycle.
 * When the PDDL solver is in-flight (no sensing events fire while idle), the Planner's
 * onPddlReady callback calls deliberate() directly so the agent reacts immediately on
 * solver completion rather than waiting for the next sensing event.
 */
export class BDIAgent {
    private socket: any;
    private debug: boolean;
    private beliefs: Beliefs;
    private planner: Planner;
    private intentions: Intentions;
    private executor: Executor;

    constructor(socket: any, debug = false) {
        this.socket = socket;
        this.debug = debug;
        this.beliefs = new Beliefs();
        this.intentions = new Intentions();
        this.planner = new Planner(this.intentions, this.beliefs, () => this.deliberate());
        this.executor = new Executor(socket, this.beliefs, this.intentions, this.planner, debug);

        this.socket.on('config', (config: IOConfig) => {
            this.beliefs.setSettings(config);
            const obsDist = this.beliefs.agents.getObservationDistance();
            if (obsDist !== null) this.beliefs.map.computeClusterWeights(obsDist);
        });

        this.perceive();
    }

    /**
     * Register socket listeners that update beliefs and drive the deliberation cycle.
     * Each sensing event is one deliberation tick.
     */
    perceive() {
        // Agent's own position and score — fires on every successful move
        this.socket.on('you', (me: IOAgent) => {
            this.beliefs.agents.updateMe(me);
            if (this.debug) console.log("[PERCEIVE] Me status updated — pos: [", me.x, ", ", me.y, "]| score:", me.score, "]");
        });

        // Static map — sent once at connection
        this.socket.once('map', (width: number, height: number, tiles: IOTile[]) => {
            // Server reports N-1 / M-1 for an NxM map — add 1 to both dimensions.
            this.beliefs.map.updateMap(width + 1, height + 1, tiles);
            const obsDist = this.beliefs.agents.getObservationDistance();
            if (obsDist !== null) this.beliefs.map.computeClusterWeights(obsDist);
            if (this.debug) console.log("[PERCEIVE] Map info received — width:", width, "| height:", height, "| tiles:", tiles.length);
        });

        // Periodic sensing — agents, parcels, crates; this is the main deliberation trigger
        this.socket.on('sensing', (sensing: IOSensing) => {
            this.beliefs.agents.updateOtherAgents(sensing.agents, sensing.positions);
            this.beliefs.parcels.updateParcels(sensing.parcels, sensing.positions);
            this.beliefs.map.updateCrates(sensing.crates, sensing.positions);
            this.beliefs.map.updateSpawnTilesSensingTimes(sensing.positions, Date.now());

            if (this.debug) {
                console.log("[PERCEIVE] Sensing update — agents:", sensing.agents.length,
                    "| parcels:", sensing.parcels.length, "| crates:", sensing.crates.length);
                console.log("[PERCEIVE] Current beliefs state:");
                console.log("  - Friends:", this.beliefs.agents.getCurrentFriends().length, "agents");
                console.log("  - Enemies:", this.beliefs.agents.getCurrentEnemies().length, "agents");
                console.log("  - Parcels:", this.beliefs.parcels.getCurrentParcels().length, "parcels");
                console.log("  - Crates:", this.beliefs.map.getCurrentCrates().length, "crates");
            }

            this.deliberate();
        });
    }

    /**
     * One deliberation cycle: rebuild desires → update intention queue → plan → execute one step.
     * CLEAR_CRATE enters the deliberation cycle automatically via intentions.crateDesires.
     */
    deliberate(): void {
        const desires = generateDesires(this.beliefs);
        if (this.debug) console.log("[DELIBERATE] Desires:", desires);

        this.intentions.update(this.beliefs);

        this.executor.start();
    }
}
