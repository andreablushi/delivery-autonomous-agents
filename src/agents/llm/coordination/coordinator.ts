import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { Communication } from "../../communication/communication.js";
import { PeerKind, type BeliefsReport, type PeerInjectionMessage, type PeerInjectionKind } from "../../../models/message_injection.js";
import type { InjectedIntention } from "../../../models/intentions.js";
import type { LLMClient } from "../client/llm_client.js";
import { parseRendezvousArgs, parseRedLightArgs, parseGotoArgs } from "../../../models/injection_args.js";
import { buildTeamGeometry, type TeamGeometry } from "./geometry.js";
import { createLogger, type Logger } from "../../../utils/logger.js";
import { config } from "../../../config.js";
import { StrategyType, StrategyRole, type GameStrategy } from "../../../models/game_strategy.js";
import { bfsDistancesFrom, posKey, manhattanDistance } from "../../../utils/metrics.js";
import { MapBeliefs } from "../../bdi/belief/modules/map_beliefs.js";
import type { Position } from "../../../models/position.js";
import { buildRendezvousHolds, buildHolds } from "../../cooperation/holds.js";

/**
 * Owns the team-coordination loop for the LLM agent.
 *
 * Periodically (or on demand):
 *  1. Broadcasts a `request_beliefs` message to all sensed friends.
 *  2. Waits COLLECT_WINDOW_MS for `beliefs_report` replies.
 *  3. Computes team geometry deterministically.
 *  4. Calls `LLMClient.coordinate` so the LLM assigns roles via `assign_goto`.
 */
export class Coordinator {
    private readonly reports = new Map<string, { report: BeliefsReport; at: number }>();
    private readonly votes = new Map<string, { rid: string; accept: boolean; at: number }>();
    private coordinating = false;
    private lastRound = 0;
    /** Geometry computed in the last coordination round — used by assignPosture. */
    private lastGeometry: TeamGeometry | null = null;
    /** Fresh reports collected in the last coordination round — used by assignPosture. */
    private lastReports: Map<string, BeliefsReport> = new Map();
    /**
     * Opportunistic mode state. Set by assignPosture("OPPORTUNISTIC") and cleared by NONE/ZONAL_RELAY.
     * When set, a successful pickup triggers a reactive handoff proposal via maybeProposeOpportunisticHandoff.
     */
    private opportunistic: { bonus?: number; expiresAt: number } | null = null;
    /** Timestamp of the last opportunistic handoff proposal — used for cooldown. */
    private lastOpportunisticProposeAt = 0;
    private readonly log: Logger;

    constructor(
        private readonly beliefs: Readonly<Beliefs>,
        private readonly comm: Communication,
        private readonly client: LLMClient,
        private readonly addInjectedIntention: (entry: InjectedIntention) => void,
        private readonly setGameStrategy: (strategy: GameStrategy) => void,
        private readonly getMissionNote: () => string = () => "",
    ) {
        this.log = createLogger("coordination");
    }

    /**
     * Handle an already-decoded coordination message (beliefs_report or rendezvous_vote).
     * Called by the Communication inbound router via the coordination hook.
     */
    handleInbound(senderId: string, msg: PeerInjectionMessage): void {
        if (msg.tool === PeerKind.BeliefsReport) {
            this.log.debug(`Received beliefs_report from ${senderId}`);
            this.reports.set(senderId, { report: msg.args, at: Date.now() });
        } else if (
            msg.tool === PeerKind.RendezvousVote ||
            msg.tool === PeerKind.RedLightVote ||
            msg.tool === PeerKind.GotoVote
        ) {
            const args = msg.args as Record<string, unknown>;
            if (typeof args.rid === "string" && typeof args.accept === "boolean") {
                this.log.debug(`Received ${msg.tool} from ${senderId}: accept=${args.accept} rid=${args.rid}`);
                this.votes.set(senderId, { rid: args.rid, accept: args.accept, at: Date.now() });
            }
        }
    }

    async proposeGoto(agentId: string, rawArgs: unknown): Promise<string> {
        const p = parseGotoArgs(rawArgs);
        if ("error" in p) return JSON.stringify(p);
        if (!this.beliefs.map.checkMapBounds(p.target_x, p.target_y)) return JSON.stringify({ error: "Coordinates out of map bounds" });
        if (!this.beliefs.agents.getTeammateIds().has(agentId)) return JSON.stringify({ error: `Agent ${agentId} is not a known teammate` });
        const rid = `goto-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        return this.runTwoPhaseCommit({
            label: "Goto", rid,
            proposeKind: PeerKind.GotoPropose, commitKind: PeerKind.GotoCommit, abortKind: PeerKind.GotoAbort,
            proposeArgs: { rid, target_x: p.target_x, target_y: p.target_y, reward: p.reward, ttl_seconds: p.ttl_seconds },
            recipients: [agentId],
            onCommit: () => {},
        });
    }

    async proposeRendezvous(rawArgs: unknown): Promise<string> {
        const p = parseRendezvousArgs(rawArgs);
        if ("error" in p) return JSON.stringify(p);
        if (!this.beliefs.map.checkMapBounds(p.x, p.y)) return JSON.stringify({ error: "Coordinates out of map bounds" });
        const from = this.beliefs.agents.getCurrentPosition();
        if (!from) return JSON.stringify({ error: "Agent position not yet known" });
        const center = { x: p.x, y: p.y };
        const rid = `rdv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const selfHolds = buildRendezvousHolds(this.beliefs as Beliefs, from, center, p.max_distance, p.reward, {
            releaseZone: { center, maxDistance: p.max_distance },
            rendezvousId: rid,
            sourceId: "coordinator",
        });
        if (selfHolds.length === 0) return JSON.stringify({ error: "No reachable tile within rendezvous zone for self" });
        return this.runTwoPhaseCommit({
            label: "Rendezvous", rid,
            proposeKind: PeerKind.RendezvousPropose, commitKind: PeerKind.RendezvousCommit, abortKind: PeerKind.RendezvousAbort,
            proposeArgs: { rid, x: p.x, y: p.y, max_distance: p.max_distance, reward: p.reward },
            onCommit: () => {
                for (const hold of selfHolds) this.addInjectedIntention(hold);
            },
        });
    }

    async proposeRedLight(rawArgs: unknown): Promise<string> {
        const p = parseRedLightArgs(rawArgs);
        if ("error" in p) return JSON.stringify(p);
        const from = this.beliefs.agents.getCurrentPosition();
        if (!from) return JSON.stringify({ error: "Agent position not yet known" });
        const selfTiles = (this.beliefs as Beliefs).map.allLineTiles(from, p.axis, p.parity);
        if (selfTiles.length === 0) return JSON.stringify({ error: "No matching tile reachable for self" });
        const rid = `rl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        return this.runTwoPhaseCommit({
            label: "Red light", rid,
            proposeKind: PeerKind.RedLightPropose, commitKind: PeerKind.RedLightCommit, abortKind: PeerKind.RedLightAbort,
            proposeArgs: { rid, reward: p.reward, ttl_seconds: p.ttl_seconds, axis: p.axis, parity: p.parity },
            onCommit: () => {
                const expiresAt = Date.now() + p.ttl_seconds * 1_000;
                const holds = buildHolds(selfTiles, p.reward, { sourceId: "coordinator", expiresAt });
                for (const hold of holds) this.addInjectedIntention(hold);
            },
        });
    }

    /**
     * Shared two-phase commit skeleton used by both proposeRendezvous and proposeRedLight.
     *
     * Phase 1 — send `proposeKind` to all teammates.
     * Phase 2 — wait commitWindowMs; if every peer voted yes for this rid, broadcast
     * `commitKind` and call `onCommit`; otherwise broadcast `abortKind`.
     */
    private async runTwoPhaseCommit(opts: {
        label: string;
        rid: string;
        proposeKind: Exclude<PeerInjectionKind, "beliefs_report">;
        commitKind: Exclude<PeerInjectionKind, "beliefs_report">;
        abortKind: Exclude<PeerInjectionKind, "beliefs_report">;
        proposeArgs: Record<string, unknown>;
        onCommit: () => void;
        /** Subset of peers to address. Defaults to all teammates. */
        recipients?: string[];
    }): Promise<string> {
        const { label, rid, proposeKind, commitKind, abortKind, proposeArgs, onCommit } = opts;
        const teammateIds = opts.recipients ?? [...this.beliefs.agents.getTeammateIds()];

        if (teammateIds.length === 0) {
            onCommit();
            return JSON.stringify({ ok: true });
        }

        const sentAt = Date.now();
        for (const id of teammateIds) {
            await this.comm.send(id, proposeKind, proposeArgs);
        }

        await new Promise<void>(r => setTimeout(r, config.rendezvous.commitWindowMs));

        const allAccepted = teammateIds.every(id => {
            const vote = this.votes.get(id);
            return vote && vote.rid === rid && vote.accept && vote.at >= sentAt;
        });

        if (allAccepted) {
            this.log.debug(`${label} ${rid}: all peers accepted — committing`);
            for (const id of teammateIds) {
                await this.comm.send(id, commitKind, proposeArgs);
            }
            onCommit();
            return JSON.stringify({ ok: true });
        } else {
            this.log.debug(`${label} ${rid}: not all peers accepted — aborting`);
            for (const id of teammateIds) {
                await this.comm.send(id, abortKind, { rid });
            }
            return JSON.stringify({ ok: false, reason: `${label} rejected: not all peers accepted` });
        }
    }

    /** Broadcast a `request_beliefs` message to all configured teammates. */
    private async requestBeliefs(): Promise<void> {
        await this.comm.broadcast(PeerKind.RequestBeliefs, {});
    }

    /**
     * Run one coordination round:
     *  - request beliefs from all friends
     *  - wait for reports
     *  - compute geometry
     *  - invoke the LLM to assign positions
     *
     * Re-entrant calls and calls within COOLDOWN_MS are silently dropped.
     */
    async runRound(): Promise<void> {
        const now = Date.now();
        if (this.coordinating || now - this.lastRound < config.coordination.cooldownMs) {
            this.log.debug("Coordination round skipped (already running or in cooldown)");
            return;
        }
        if (this.beliefs.agents.getTeammateIds().size === 0) {
            this.log.debug("Coordination round skipped (no teammates configured)");
            return;
        }

        this.coordinating = true;
        this.lastRound = now;
        this.log.debug("Starting coordination round");

        try {
            await this.requestBeliefs();
            const requestedAt = Date.now();

            // Wait for reports to arrive
            await new Promise<void>(r => setTimeout(r, config.coordination.collectWindowMs));

            // Collect only reports that arrived after this request was sent
            const freshReports = new Map<string, BeliefsReport>();
            for (const [id, { report, at }] of this.reports) {
                if (at >= requestedAt) freshReports.set(id, report);
            }

            this.log.debug(`Collected ${freshReports.size} fresh report(s), running LLM coordinate pass`);
            const geometry = buildTeamGeometry(this.beliefs, freshReports);
            // Stash for use by assignPosture (called synchronously inside client.coordinate).
            this.lastGeometry = geometry;
            this.lastReports = freshReports;
            await this.client.coordinate(freshReports, geometry, this.beliefs, () => void this.runRound(), this.getMissionNote());
        } catch (err) {
            this.log.error("Coordination round failed:", err);
        } finally {
            this.coordinating = false;
        }
    }

    // ─── Deterministic posture assignment ────────────────────────────────────

    /**
     * Deterministically assign all agents to roles based on the chosen posture.
     * Called from the `set_team_posture` tool handler inside a coordinate() pass.
     *
     * Postures:
     *   ZONAL_RELAY  — one PICKUP_AGENT (sweeps the full spawn region, drops at the spawn-side edge tile)
     *                  + one DELIVER_AGENT (waits at the edge tile, ferries parcels to real deliveries).
     *                  Requires ≥2 agents and a valid spawnEdge; otherwise assigns nothing.
     *   OPPORTUNISTIC — both agents roam autonomously; a successful pickup reactively triggers a
     *                   handoff proposal via maybeProposeOpportunisticHandoff. No roles assigned.
     *   NONE          — no assignment; active strategies lapse on their TTL.
     */
    async assignPosture(posture: string, opts: { bonus?: number } = {}): Promise<string> {
        if (posture === "NONE") {
            this.opportunistic = null;
            this.log.debug("assignPosture: NONE — strategies will lapse on TTL");
            return JSON.stringify({ ok: true, posture: "NONE" });
        }

        if (posture === "OPPORTUNISTIC") {
            const ttlSeconds = Math.min(120, Math.ceil(config.coordination.intervalMs / 1000) * 2);
            this.opportunistic = { bonus: opts.bonus, expiresAt: Date.now() + ttlSeconds * 1_000 };
            this.log.debug(`assignPosture: OPPORTUNISTIC armed, bonus=${opts.bonus ?? 0}, ttl=${ttlSeconds}s`);
            return JSON.stringify({ ok: true, posture: "OPPORTUNISTIC", bonus: opts.bonus });
        }

        if (posture !== "ZONAL_RELAY") return JSON.stringify({ error: `Unknown posture: ${posture}` });

        // Clear opportunistic mode when switching to ZONAL_RELAY
        this.opportunistic = null;

        if (!this.lastGeometry) return JSON.stringify({ error: "No geometry available — wait for the first coordination round" });

        const map = this.beliefs.map.getMap();
        if (!map) return JSON.stringify({ error: "Map not yet loaded" });

        // TTL spans two coordination intervals so a strategy survives the gap between rounds
        // (and a slow LLM call); the next assignment overrides it via setGameStrategy.
        const ttlSeconds = Math.min(120, Math.ceil(config.coordination.intervalMs / 1000) * 2);

        // Build roster: self + teammates that reported a position this round.
        const me = this.beliefs.agents.getCurrentMe();
        const myPos = this.beliefs.agents.getCurrentPosition();
        type RosterEntry = { id: string; pos: Position; bfs: Map<string, number> };

        const walkable = (from: Position, to: Position) =>
            MapBeliefs.isStaticWalkable(map.tiles, map.width, map.height, from, to);

        const roster: RosterEntry[] = [];
        if (me && myPos) roster.push({ id: me.id, pos: myPos, bfs: bfsDistancesFrom(myPos, walkable) });
        for (const [id, report] of this.lastReports) {
            if (report.pos) {
                roster.push({ id, pos: report.pos, bfs: bfsDistancesFrom(report.pos, walkable) });
            }
        }

        if (roster.length === 0) return JSON.stringify({ error: "No agents with known positions" });

        return this.assignZonalRelay(roster, ttlSeconds, opts.bonus);
    }

    /**
     * Called after a successful pickup when OPPORTUNISTIC mode is armed.
     * Guards: mode still active, cooldown elapsed, exactly one teammate, carrying ≥1 parcel,
     * partner meaningfully closer to delivery than the carrier.
     * On a go: injects DELIVER_PARCEL at a live-computed meet tile for the carrier and
     * proposes a GOTO to the partner via the existing 2PC path.
     */
    async maybeProposeOpportunisticHandoff(): Promise<void> {
        if (!this.opportunistic) return;
        const now = Date.now();
        if (now > this.opportunistic.expiresAt) {
            this.opportunistic = null;
            return;
        }
        if (now - this.lastOpportunisticProposeAt < config.coordination.opportunisticCooldownMs) return;

        const teammates = this.beliefs.agents.getTeammateIds();
        if (teammates.size !== 1) return;
        const partnerId = [...teammates][0]!;

        const me = this.beliefs.agents.getCurrentMe();
        if (!me) return;
        const myPos = this.beliefs.agents.getCurrentPosition();
        if (!myPos) return;

        const carried = (this.beliefs as Beliefs).parcels.getCarriedByAgent(me.id);
        if (carried.length === 0) return;

        const partner = this.beliefs.agents.getCurrentFriends().find(f => f.id === partnerId);
        const partnerPos = partner?.lastPosition ?? null;
        if (!partnerPos) return;

        const deliveryTiles = (this.beliefs as Beliefs).map.getDeliveryTiles();
        if (deliveryTiles.length === 0) return;

        // Quick Manhattan check: partner must be meaningfully closer to a delivery tile.
        const myDelDist = Math.min(...deliveryTiles.map(t => manhattanDistance(myPos, t)));
        const partnerDelDist = Math.min(...deliveryTiles.map(t => manhattanDistance(partnerPos, t)));
        if (partnerDelDist >= myDelDist - config.coordination.opportunisticMinPartnerSaving) return;

        // Compute live meet tile: midpoint between carrier and their nearest delivery, snapped to reachable.
        const nearestDel = deliveryTiles.reduce((best, t) =>
            manhattanDistance(myPos, t) < manhattanDistance(myPos, best) ? t : best
        );
        const cx = Math.round((myPos.x + nearestDel.x) / 2);
        const cy = Math.round((myPos.y + nearestDel.y) / 2);
        const reachable = (this.beliefs as Beliefs).map.allRendezvousTiles(myPos, cx, cy, config.coordination.opportunisticMeetRadius);
        if (reachable.length === 0) return;
        const meetTile = reachable[0]!;

        const bonus = this.opportunistic.bonus ?? 0;
        const carriedValue = carried.reduce((sum, p) => sum + p.reward, 0);
        const reward = Math.max(1, bonus + carriedValue);
        const ttlSeconds = 30;

        this.lastOpportunisticProposeAt = now;

        // Carrier: inject DELIVER_PARCEL at meet tile — carrier goes there and drops parcels.
        this.addInjectedIntention({
            desire: { type: "DELIVER_PARCEL", target: meetTile, bonus: bonus > 0 ? bonus : undefined },
            expiresAt: now + ttlSeconds * 1_000,
            sourceId: "opportunistic",
        });

        // Partner: propose GOTO via 2PC — partner navigates to meet tile (PARK_TILE), picks up grounded parcels autonomously.
        this.log.debug(`Opportunistic handoff: proposing goto to ${partnerId} @ (${meetTile.x},${meetTile.y}), reward=${reward}`);
        await this.proposeGoto(partnerId, { target_x: meetTile.x, target_y: meetTile.y, reward, ttl_seconds: ttlSeconds });
    }

    /**
     * Anchor value = base (e.g. spawn tileCount) minus enemy heat at the anchor tile.
     * Uses the same Gaussian heat model as the EXPLORE scorer for consistency.
     * Higher value → more attractive anchor for greedy matching.
     */
    private anchorValue(anchor: Position, baseValue: number): number {
        return baseValue - this.beliefs.agents.getEnemyHeatAt(anchor);
    }

    /**
     * Greedy max-weight bipartite matching: each agent gets at most one anchor.
     * Score for pair (a, b) = anchor.value − 0.5 * BFS-distance(a→b).
     * Returns assignments in greedy order (best score first).
     */
    private greedyMatch(
        agents: Array<{ id: string; bfs: Map<string, number> }>,
        anchors: Array<{ pos: Position; value: number }>,
    ): Array<{ agentId: string; anchor: { pos: Position; value: number }; dist: number }> {
        const remAgents = agents.map((a, i) => ({ i, a }));
        const remAnchors = [...anchors.map((a, j) => ({ j, a }))];
        const result: Array<{ agentId: string; anchor: { pos: Position; value: number }; dist: number }> = [];

        while (remAgents.length > 0 && remAnchors.length > 0) {
            let best = -Infinity, ba = 0, bb = 0;
            for (let a = 0; a < remAgents.length; a++) {
                for (let b = 0; b < remAnchors.length; b++) {
                    const dist = remAgents[a].a.bfs.get(posKey(remAnchors[b].a.pos)) ?? Infinity;
                    const score = remAnchors[b].a.value - 0.5 * dist;
                    if (score > best) { best = score; ba = a; bb = b; }
                }
            }
            const { a: agent } = remAgents[ba];
            const { a: anchor } = remAnchors[bb];
            const dist = agent.bfs.get(posKey(anchor.pos)) ?? Infinity;
            result.push({ agentId: agent.id, anchor, dist });
            remAgents.splice(ba, 1);
            remAnchors.splice(bb, 1);
        }
        return result;
    }

    /**
     * ZONAL_RELAY: PICKUP_AGENT sweeps the full spawn region, drops at the spawn-side edge tile;
     * DELIVER_AGENT waits at the edge tile, ferries received parcels to real delivery tiles, returns.
     * Requires at least 2 agents and a valid spawnEdge tile.
     */
    private async assignZonalRelay(
        roster: Array<{ id: string; pos: Position; bfs: Map<string, number> }>,
        ttlSeconds: number,
        bonus?: number,
    ): Promise<string> {
        if (roster.length < 2) {
            this.log.debug("ZONAL_RELAY: not enough agents — skipping assignment");
            return JSON.stringify({ ok: true, posture: "ZONAL_RELAY", assignments: [] });
        }
        const geometry = this.lastGeometry!;

        const meetTile = geometry.spawnEdge;
        if (!meetTile) return JSON.stringify({ error: "No spawn region edge tile for ZONAL_RELAY" });

        const spawnAnchors = geometry.spawnClusters.map(c => ({
            pos: c.centroid,
            value: this.anchorValue(c.centroid, c.tileCount),
        }));

        if (spawnAnchors.length === 0) {
            return JSON.stringify({ error: "No spawn clusters for ZONAL_RELAY" });
        }

        // Agent closest to the spawn mass → PICKUP; other → DELIVER.
        const [pickupMatch] = this.greedyMatch(roster, spawnAnchors);
        if (!pickupMatch) return JSON.stringify({ error: "Could not assign PICKUP_AGENT" });
        const deliverAgent = roster.find(a => a.id !== pickupMatch.agentId);
        if (!deliverAgent) return JSON.stringify({ error: "No remaining agent for DELIVER_AGENT" });

        const results: string[] = [];

        // PICKUP_AGENT: sweeps full spawn region, drops at spawn-side edge tile.
        // No pickup_zone_x/y → PickupRole sweeps all spawn tiles via region membership filter.
        results.push(await this.emitStrategyAssignment(pickupMatch.agentId, {
            strategy: StrategyType.ZonalRelay, role: StrategyRole.PickupAgent,
            tile_x: meetTile.x, tile_y: meetTile.y,
            max_distance: config.handoff.zoneRadius, ttl_seconds: ttlSeconds,
            bonus, partner_id: deliverAgent.id,
        }));

        // DELIVER_AGENT: waits at the edge tile, ferries received parcels to real delivery tiles, returns.
        results.push(await this.emitStrategyAssignment(deliverAgent.id, {
            strategy: StrategyType.ZonalRelay, role: StrategyRole.DeliverAgent,
            tile_x: meetTile.x, tile_y: meetTile.y,
            max_distance: config.handoff.zoneRadius, ttl_seconds: ttlSeconds,
            bonus, partner_id: pickupMatch.agentId,
        }));

        this.log.debug(`ZONAL_RELAY: meet=(${meetTile.x},${meetTile.y}) | ${results.join(" | ")}`);
        return JSON.stringify({ ok: true, posture: "ZONAL_RELAY", assignments: results });
    }

    /**
     * Apply an AssignStrategy to a specific agent.
     * Self → apply locally via setGameStrategy (+ HOLD_TILE for DELIVER_AGENT).
     * Teammate → send via comm.
     */
    private async emitStrategyAssignment(
        agentId: string,
        args: {
            strategy: StrategyType; role: StrategyRole;
            tile_x: number; tile_y: number; max_distance: number; ttl_seconds: number;
            bonus?: number; partner_id?: string;
            pickup_zone_x?: number; pickup_zone_y?: number;
        },
    ): Promise<string> {
        const me = this.beliefs.agents.getCurrentMe();
        if (agentId === me?.id) {
            this.applyLocalStrategy(args);
            return JSON.stringify({ ok: true, agentId, role: args.role });
        }
        const wireArgs: Record<string, unknown> = { ...args };
        await this.comm.send(agentId, PeerKind.AssignStrategy, wireArgs);
        return JSON.stringify({ ok: true, agentId, role: args.role });
    }

    /**
     * Mirror of apply_injection.ts AssignStrategy case, but called locally by the coordinator.
     * Calls setGameStrategy and, for DELIVER_AGENT, injects the HOLD_TILE rendezvous desires.
     */
    private applyLocalStrategy(args: {
        strategy: StrategyType; role: StrategyRole;
        tile_x: number; tile_y: number; max_distance: number; ttl_seconds: number;
        bonus?: number; partner_id?: string;
        pickup_zone_x?: number; pickup_zone_y?: number;
    }): void {
        const expiresAt = Date.now() + args.ttl_seconds * 1_000;
        const center = { x: args.tile_x, y: args.tile_y };
        const pickupZoneCenter = (args.pickup_zone_x !== undefined && args.pickup_zone_y !== undefined)
            ? { x: args.pickup_zone_x, y: args.pickup_zone_y }
            : undefined;

        this.setGameStrategy({
            strategy: args.strategy,
            role: args.role,
            tiles: [center],
            pickupZoneCenter,
            maxDistance: args.max_distance,
            bonus: args.bonus,
            partnerId: args.partner_id,
            expiresAt,
        });

        // The RoleController in Intentions generates gated desires each cycle — nothing to inject here.
    }

    /** Start the periodic coordination interval. */
    start(): void {
        this.log.debug(`Coordination interval: ${config.coordination.intervalMs}ms`);
        setInterval(() => { void this.runRound(); }, config.coordination.intervalMs);
    }
}
