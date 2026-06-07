import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { Communication } from "../../communication/communication.js";
import { PeerKind, type BeliefsReport, type PeerInjectionMessage, type PeerInjectionKind } from "../../../models/message_injection.js";
import type { InjectedDesire } from "../../../models/desires.js";
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
import { findApproachPair } from "../../cooperation/roles/handoff_geometry.js";

/**
 * Owns the team-coordination loop for the LLM agent.
 *
 * Periodically (or on demand):
 *  1. Broadcasts a `request_beliefs` message to all sensed friends.
 *  2. Waits COLLECT_WINDOW_MS for `beliefs_report` replies.
 *  3. Computes team geometry deterministically.
 *  4. Calls `LLMClient.coordinate` so the LLM picks a cooperation posture.
 */
/** Valid posture strings, used as keys in the per-posture stats tables. */
const POSTURES = ["ZONAL_RELAY", "OPPORTUNISTIC", "NONE"] as const;
type Posture = typeof POSTURES[number];

export class Coordinator {
    private readonly reports = new Map<string, { report: BeliefsReport; at: number }>();
    private readonly votes = new Map<string, { rid: string; accept: boolean; at: number }>();
    private coordinating = false;
    private lastRound = 0;
    /** Geometry computed in the last coordination round — used by assignPosture. */
    private lastGeometry: TeamGeometry | null = null;
    /** Fresh reports collected in the last coordination round — used by assignPosture. */
    private lastReports: Map<string, BeliefsReport> = new Map();
    private readonly log: Logger;

    // ─── Strategy performance tracking ───────────────────────────────────────
    /** Sliding window of team-score gains (Δscore/round) per posture. */
    private readonly recentGains = new Map<Posture, number[]>(POSTURES.map(p => [p, []]));
    /** Posture that was active during the interval just elapsed (set by assignPosture). */
    private lastPosture: Posture | null = null;
    /** Team score snapshot at the end of the previous round, for delta computation. */
    private lastTeamScore: number | null = null;

    constructor(
        private readonly beliefs: Readonly<Beliefs>,
        private readonly comm: Communication,
        private readonly client: LLMClient,
        private readonly addInjectedDesire: (entry: InjectedDesire) => void,
        private readonly setGameStrategy: (strategy: GameStrategy) => void,
        private readonly getMissionNote: () => string = () => "",
        private readonly armHandpass: (bonus: number | undefined, ttlMs: number) => void = () => {},
        private readonly disarmHandpass: () => void = () => {},
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
                for (const hold of selfHolds) this.addInjectedDesire(hold);
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
                for (const hold of holds) this.addInjectedDesire(hold);
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
     * Re-entrant calls are always dropped. Cooldown is skipped when `opts.force` is true
     * (used to trigger an immediate round after an admin mission message).
     */
    async runRound(opts?: { force?: boolean }): Promise<void> {
        const now = Date.now();
        if (this.coordinating) {
            this.log.debug("Coordination round skipped (already running)");
            return;
        }
        if (!opts?.force && now - this.lastRound < config.coordination.cooldownMs) {
            this.log.debug("Coordination round skipped (in cooldown)");
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

            // Sample team score and attribute the delta to the just-elapsed posture.
            this.sampleStrategyPerformance(freshReports);
            const performance = this.formatStrategyStats();

            const geometry = buildTeamGeometry(this.beliefs, freshReports);
            // Stash for use by assignPosture (called synchronously inside client.coordinate).
            this.lastGeometry = geometry;
            this.lastReports = freshReports;

            // Deterministic short-circuit: on single-file corridors where agents cannot pass
            // each other, relay cooperation is the only productive strategy — skip the LLM.
            if (
                geometry.singleFile &&
                (geometry.spawnDeliverySeparation ?? 0) >= config.coordination.corridorSeparationMin
            ) {
                this.log.debug(
                    `Single-file corridor (sep=${geometry.spawnDeliverySeparation}) — forcing ZONAL_RELAY, skipping LLM`,
                );
                await this.assignPosture("ZONAL_RELAY");
                return;
            }

            await this.client.coordinate(freshReports, geometry, this.beliefs, this.getMissionNote(), performance);
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
     *   OPPORTUNISTIC — arms the HandpassInitiator on both agents. Both search autonomously; the first
     *                   to pick up initiates a handshake handpass via the BDI-layer HandpassInitiator.
     *   NONE          — disarms handpass on both agents; active strategies lapse on their TTL.
     */
    async assignPosture(posture: string, opts: { bonus?: number } = {}): Promise<string> {
        if (posture === "NONE") {
            this.lastPosture = "NONE";
            this.disarmHandpass();
            await this.comm.broadcast(PeerKind.SetHandpassMode, { armed: false });
            this.log.debug("assignPosture: NONE — strategies will lapse on TTL");
            return JSON.stringify({ ok: true, posture: "NONE" });
        }

        if (posture === "OPPORTUNISTIC") {
            this.lastPosture = "OPPORTUNISTIC";
            const ttlSeconds = Math.min(120, Math.ceil(config.coordination.intervalMs / 1000) * 2);
            this.armHandpass(opts.bonus, ttlSeconds * 1_000);
            await this.comm.broadcast(PeerKind.SetHandpassMode, { armed: true, bonus: opts.bonus ?? null, ttl_seconds: ttlSeconds });
            this.log.debug(`assignPosture: OPPORTUNISTIC armed, bonus=${opts.bonus ?? 0}, ttl=${ttlSeconds}s`);
            return JSON.stringify({ ok: true, posture: "OPPORTUNISTIC", bonus: opts.bonus });
        }

        if (posture !== "ZONAL_RELAY") return JSON.stringify({ error: `Unknown posture: ${posture}` });
        this.lastPosture = "ZONAL_RELAY";

        // Disarm opportunistic mode when switching to ZONAL_RELAY
        this.disarmHandpass();
        await this.comm.broadcast(PeerKind.SetHandpassMode, { armed: false });

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
     * Compute the relay meet tile as the midpoint between the chosen pickup spawn anchor and the
     * nearest delivery cluster centroid, snapped to the nearest reachable tile via BFS from
     * `reachableOrigin`. Falls back to `reachableOrigin` when delivery clusters are absent or no
     * reachable tile is found within the snap radius.
     */
    private computeRelayMeetTile(
        spawnAnchor: Position,
        reachableOrigin: Position,
        geometry: TeamGeometry,
    ): Position {
        if (geometry.deliveryClusters.length === 0) return reachableOrigin;

        const nearestDelivery = geometry.deliveryClusters.reduce((best, c) =>
            manhattanDistance(spawnAnchor, c.centroid) < manhattanDistance(spawnAnchor, best.centroid) ? c : best
        ).centroid;

        const cx = Math.round((spawnAnchor.x + nearestDelivery.x) / 2);
        const cy = Math.round((spawnAnchor.y + nearestDelivery.y) / 2);

        const snapped = (this.beliefs as Beliefs).map.allRendezvousTiles(
            reachableOrigin, cx, cy, config.coordination.opportunisticMeetRadius,
        );
        return snapped[0] ?? reachableOrigin;
    }

    /**
     * ZONAL_RELAY: PICKUP_AGENT sweeps the full spawn region, drops at a dynamic midpoint halfway
     * between the pickup anchor and the nearest delivery zone. DELIVER_AGENT waits at that midpoint,
     * ferries received parcels to real delivery tiles, and returns.
     * Requires at least 2 agents and a valid spawnEdge tile (used as the BFS origin for snapping).
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

        // spawnEdge is the BFS-reachable reference point used for snapping and as a fallback.
        const spawnEdge = geometry.spawnEdge;
        if (!spawnEdge) return JSON.stringify({ error: "No spawn region edge tile for ZONAL_RELAY" });

        const spawnAnchors = geometry.spawnClusters.map(c => ({
            pos: c.centroid,
            // Anchor score: tile density minus enemy heat (same Gaussian model as EXPLORE scorer).
            value: c.tileCount - this.beliefs.agents.getEnemyHeatAt(c.centroid),
        }));

        if (spawnAnchors.length === 0) {
            return JSON.stringify({ error: "No spawn clusters for ZONAL_RELAY" });
        }

        // Agent closest to the spawn mass → PICKUP; other → DELIVER.
        // Pick the (agent, anchor) pair that maximises: anchor.value − 0.5 * bfs-distance.
        let pickupMatch: { agentId: string; anchor: typeof spawnAnchors[0] } | null = null;
        let bestScore = -Infinity;
        for (const agent of roster) {
            for (const anchor of spawnAnchors) {
                const dist = agent.bfs.get(posKey(anchor.pos)) ?? Infinity;
                const score = anchor.value - 0.5 * dist;
                if (score > bestScore) { bestScore = score; pickupMatch = { agentId: agent.id, anchor }; }
            }
        }
        if (!pickupMatch) return JSON.stringify({ error: "Could not assign PICKUP_AGENT" });
        const deliverAgent = roster.find(a => a.id !== pickupMatch.agentId);
        if (!deliverAgent) return JSON.stringify({ error: "No remaining agent for DELIVER_AGENT" });

        // Compute the meet tile as the midpoint between the chosen pickup anchor and the
        // nearest delivery cluster, snapped to the nearest reachable tile. This balances the
        // relay — PICKUP owns spawn→midpoint, DELIVER owns midpoint→delivery.
        const meetTile = this.computeRelayMeetTile(pickupMatch.anchor.pos, spawnEdge, geometry);

        // Compute distinct adjacent approach cells so each agent waits one step from M.
        const pickupAgent = roster.find(a => a.id === pickupMatch.agentId)!;
        const geo = findApproachPair(this.beliefs, pickupAgent.pos, deliverAgent.pos, meetTile);

        const results: string[] = [];

        // PICKUP_AGENT: sweeps full spawn region, drops exactly at M.
        results.push(await this.emitStrategyAssignment(pickupMatch.agentId, {
            strategy: StrategyType.ZonalRelay, role: StrategyRole.PickupAgent,
            tile_x: meetTile.x, tile_y: meetTile.y,
            max_distance: config.handoff.zoneRadius, ttl_seconds: ttlSeconds,
            bonus, partner_id: deliverAgent.id,
            approach_x: geo?.carrierApproach.x, approach_y: geo?.carrierApproach.y,
        }));

        // DELIVER_AGENT: waits at the approach cell, ferries received parcels to real delivery tiles, returns.
        results.push(await this.emitStrategyAssignment(deliverAgent.id, {
            strategy: StrategyType.ZonalRelay, role: StrategyRole.DeliverAgent,
            tile_x: meetTile.x, tile_y: meetTile.y,
            max_distance: config.handoff.zoneRadius, ttl_seconds: ttlSeconds,
            bonus, partner_id: pickupMatch.agentId,
            approach_x: geo?.receiverApproach.x, approach_y: geo?.receiverApproach.y,
        }));

        this.log.debug(`ZONAL_RELAY: meet=(${meetTile.x},${meetTile.y})${geo ? ` approach=(${geo.carrierApproach.x},${geo.carrierApproach.y})|(${geo.receiverApproach.x},${geo.receiverApproach.y})` : " (no approach pair)"} | ${results.join(" | ")}`);
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
            approach_x?: number; approach_y?: number;
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
        approach_x?: number; approach_y?: number;
    }): void {
        const expiresAt = Date.now() + args.ttl_seconds * 1_000;
        const center = { x: args.tile_x, y: args.tile_y };
        const approachTile = (args.approach_x !== undefined && args.approach_y !== undefined)
            ? { x: args.approach_x, y: args.approach_y }
            : undefined;

        this.setGameStrategy({
            strategy: args.strategy,
            role: args.role,
            tiles: [center],
            approachTile,
            maxDistance: args.max_distance,
            bonus: args.bonus,
            partnerId: args.partner_id,
            expiresAt,
        });

        // The RoleController in Intentions generates gated desires each cycle — nothing to inject here.
    }

    /**
     * Sample the current team score and attribute the delta to the posture that was active
     * during the elapsed interval (`lastPosture`). Maintains a bounded sliding window per posture.
     * Call this once per round, after fresh reports have been collected.
     */
    private sampleStrategyPerformance(freshReports: Map<string, BeliefsReport>): void {
        const myScore = this.beliefs.agents.getCurrentMe()?.score ?? 0;
        const teammateScore = Array.from(freshReports.values()).reduce((s, r) => s + r.score, 0);
        const teamScore = myScore + teammateScore;

        if (this.lastTeamScore !== null && this.lastPosture !== null) {
            const delta = teamScore - this.lastTeamScore;
            const window = this.recentGains.get(this.lastPosture)!;
            window.push(delta);
            if (window.length > config.coordination.perfWindowRounds) window.shift();
        }
        this.lastTeamScore = teamScore;
    }

    /** Format the per-posture performance stats for injection into the LLM coordination prompt. */
    private formatStrategyStats(): string {
        const lines: string[] = [];
        for (const posture of POSTURES) {
            const gains = this.recentGains.get(posture)!;
            if (gains.length === 0) {
                lines.push(`${posture}: no data yet`);
            } else {
                const avg = gains.reduce((s, g) => s + g, 0) / gains.length;
                const latest = gains[gains.length - 1];
                const sign = (n: number) => n >= 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
                lines.push(`${posture}: avg ${sign(avg)}/round (last ${gains.length}, latest ${sign(latest)})`);
            }
        }
        lines.push(`Current: ${this.lastPosture ?? "none"}`);
        return lines.join("\n");
    }

    /** Start the periodic coordination interval. */
    start(): void {
        this.log.debug(`Coordination interval: ${config.coordination.intervalMs}ms`);
        setInterval(() => { void this.runRound(); }, config.coordination.intervalMs);
    }
}
