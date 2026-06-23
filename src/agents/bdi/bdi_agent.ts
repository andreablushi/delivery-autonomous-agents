import { IOConfig, IOTile, IOAgent, IOSensing } from "../../models/djs.js";
import type { AgentControl } from "../../models/agent_control.js";
import { Beliefs } from "./belief/beliefs.js";
import { RuleStore } from "./desire/rule_store.js";
import { Intentions } from "./intention/intentions.js";
import { Executor } from "./execution/executor.js";
import { Planner } from "./plan/planner.js";
import { Communication } from "../communication/communication.js";
import { HandoffInitiator } from "../cooperation/handoff_initiator.js";
import { PeerInbox } from "../coordination/peer_inbox.js";
import { Negotiator } from "../coordination/negotiator.js";
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
    private peerInbox: PeerInbox;
    private negotiator: Negotiator;
    private handoff: HandoffInitiator;
    private readonly _control: AgentControl;
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
        this.comm = commFactory
            ? commFactory(socket, this.beliefs, agentId)
            : new Communication(socket, this.beliefs, agentId);
        this.peerInbox = new PeerInbox();
        this.negotiator = new Negotiator(
            this.beliefs,
            this.comm,
            this.peerInbox,
            entry => this.intentions.addInjectedDesire(entry),
        );
        this.handoff = new HandoffInitiator(
            this.beliefs,
            this.negotiator,
            strategy => this.intentions.setGameStrategy(strategy),
            createLogger("coordination", agentId),
        );

        // Single control surface used both by external strategic layers (e.g. the LLM)
        // and by the internal wiring below. Bundles every cross-cutting operation an
        // outside caller may perform; the reactive loop itself is not exposed.
        this._control = {
            beliefs: this.beliefs,
            ruleStore: this.ruleStore,
            negotiator: this.negotiator,
            peerInbox: this.peerInbox,
            addInjectedDesire: entry => this.intentions.addInjectedDesire(entry),
            removeInjectedDesiresByType: type => this.intentions.removeInjectedDesiresByType(type),
            setGameStrategy: strategy => this.intentions.setGameStrategy(strategy),
            getGameStrategy: () => this.intentions.getGameStrategy(),
            armHandoff: (bonus, ttlMs) => this.handoff.arm(bonus, ttlMs),
            disarmHandoff: () => this.handoff.disarm(),
        };

        this.executor = new Executor(socket, this.beliefs, this.intentions, this.planner, this.ruleStore, agentId,
            () => { void this.handoff.maybeInitiate(); });
        this.comm.start({
            beliefs: this.beliefs,
            ruleStore: this.ruleStore,
            addInjectedDesire: this._control.addInjectedDesire,
            removeInjectedDesiresByType: this._control.removeInjectedDesiresByType,
            setGameStrategy: this._control.setGameStrategy,
            armHandoff: this._control.armHandoff,
            disarmHandoff: this._control.disarmHandoff,
            peerInbox: this.peerInbox,
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
     * Control surface for external strategic layers (e.g. the LLM): read beliefs,
     * inject/revoke desires, set strategy, and arm handoff. The perceive→deliberate→
     * execute loop is intentionally not part of this port.
     * @returns The agent's {@link AgentControl}.
     */
    control(): AgentControl {
        return this._control;
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
        this.executor.start();
    }
}
