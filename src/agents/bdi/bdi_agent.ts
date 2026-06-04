import { IOConfig, IOTile, IOAgent, IOSensing } from "../../models/djs.js";
import type { InjectedIntention } from "../../models/intentions.js";
import type { DesireType } from "../../models/desires.js";
import type { GameStrategy } from "../../models/game_strategy.js";
import { HandshakeManager } from "../cooperation/handshake.js";
import { Beliefs } from "./belief/beliefs.js";
import { RuleStore } from "./desire/rule_store.js";
import { Intentions } from "./intention/intentions.js";
import { Executor } from "./execution/executor.js";
import { Planner } from "./plan/planner.js";
import { Communication } from "../communication/communication.js";
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
    private ruleStore: RuleStore;
    private planner: Planner;
    private intentions: Intentions;
    private executor: Executor;
    private comm: Communication;
    private handshakeManager: HandshakeManager;
    private perceiveLog;
    private deliberateLog;

    constructor(
        socket: any,
        agentId?: string,
        teammateIds?: string[],
        commFactory?: (socket: any, beliefs: Beliefs, agentId?: string) => Communication,
    ) {
        this.socket = socket;
        this.perceiveLog = createLogger("perceive", agentId);
        this.deliberateLog = createLogger("deliberate", agentId);
        this.beliefs = new Beliefs(agentId, teammateIds);
        this.ruleStore = new RuleStore();
        this.intentions = new Intentions(agentId);
        this.planner = new Planner(this.intentions, this.beliefs, agentId);
        this.executor = new Executor(socket, this.beliefs, this.intentions, this.planner, this.ruleStore, agentId,
            () => this.handshakeManager.tick()); // re-check handshake immediately after a pickup
        this.comm = commFactory
            ? commFactory(socket, this.beliefs, agentId)
            : new Communication(socket, this.beliefs, agentId);
        this.handshakeManager = new HandshakeManager(
            this.beliefs,
            this.ruleStore,
            (toId, tool, args) => this.comm.send(toId, tool as Parameters<typeof this.comm.send>[1], args),
            entry => this.addInjectedIntention(entry),
            predicate => this.intentions.removeInjectedIntentions(predicate),
            () => this.getGameStrategy(),
            agentId,
        );
        this.comm.start({
            beliefs: this.beliefs,
            ruleStore: this.ruleStore,
            addInjectedIntention: entry => this.addInjectedIntention(entry),
            removeIntentionsByType: type => this.removeIntentionsByType(type),
            setGameStrategy: strategy => this.setGameStrategy(strategy),
            getGameStrategy: () => this.getGameStrategy(),
            handleHandshake: (senderId, tool, args) => this.handshakeManager.handleInbound(senderId, tool, args),
        });

        this.socket.once('controller', (status: string, agent: { id: string; name: string; teamId: string; teamName: string; score: number }) => {
            if (status === 'connected') this.beliefs.agents.updateOtherAgents([agent as IOAgent], []);
        });

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
     * Expose the rule store for external mutation (e.g. by LLM tool handlers).
     * @returns The agent's RuleStore instance.
     */
    getRuleStore(): RuleStore {
        return this.ruleStore;
    }

    /**
     * Add an injected intention that will be included in the intention queue each cycle until it expires.
     * Useful for desires injected by an LLM or other external system that should persist across multiple cycles.
     * @param entry The injected intention entry, including the desire itself and its expiration time.
     */
    addInjectedIntention(entry: InjectedIntention): void {
        this.intentions.addInjectedIntention(entry);
    }

    /**
     * Remove all intentions of a given desire type from the intention queue.
     * Useful for revoking desires injected by an LLM or other external system.
     * @param type The type of desire whose intentions should be removed.
     */
    removeIntentionsByType(type: DesireType["type"]): void {
        this.intentions.removeIntentionsByType(type);
    }

    /** Set the active cooperation strategy assigned by the coordinator. */
    setGameStrategy(strategy: GameStrategy): void {
        this.intentions.setGameStrategy(strategy);
    }

    /** Returns the active cooperation strategy, or null if none. */
    getGameStrategy(): GameStrategy | null {
        return this.intentions.getGameStrategy();
    }

    /** Clear the active cooperation strategy. */
    clearGameStrategy(): void {
        this.intentions.clearGameStrategy();
    }


    /**
     * Expose the communication module for external use (e.g. by LLMAgent to register hooks).
     * @returns The agent's Communication instance.
     */
    getCommunication(): Communication {
        return this.comm;
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
        this.socket.on('sensing', async (sensing: IOSensing) => {
            this.beliefs.agents.updateOtherAgents(sensing.agents, sensing.positions);
            this.beliefs.parcels.updateParcels(sensing.parcels, sensing.positions);
            this.beliefs.crates.updateCrates(sensing.crates, sensing.positions);
            this.beliefs.map.updateSpawnTilesSensingTimes(sensing.positions, Date.now());

            this.perceiveLog.debug("Sensing update — agents:", sensing.agents.length,
                "| parcels:", sensing.parcels.length, "| crates:", sensing.crates.length);
            this.perceiveLog.debug("Current beliefs state:");
            this.perceiveLog.debug("  - Friends:", this.beliefs.agents.getCurrentFriends().length, "agents");
            this.perceiveLog.debug("  - Enemies:", this.beliefs.agents.getCurrentEnemies().length, "agents");
            this.perceiveLog.debug("  - Parcels:", this.beliefs.parcels.getCurrentParcels().length, "parcels");
            this.perceiveLog.debug("  - Crates:", this.beliefs.crates.getCurrentCrates().length, "crates");

            this.deliberate();
            this.executor.kick();
        });
    }

    /**
     * One deliberation cycle: rebuild desires → update intention queue → plan → execute one step.
     */
    deliberate(): void {
        this.intentions.update(this.beliefs, this.ruleStore);
        this.deliberateLog.debug("Intention selected:", this.intentions.getIntentionHead());
        this.handshakeManager.tick(); // drive handshake state machine each cycle
        this.executor.start();
    }
}
