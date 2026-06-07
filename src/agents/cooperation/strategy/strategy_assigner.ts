import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { Communication } from "../../communication/communication.js";
import type { BeliefsReport } from "../../../models/message_injection.js";
import type { InjectedDesire } from "../../../models/desires.js";
import type { TeamGeometry } from "../geometry.js";
import type { Position } from "../../../models/position.js";
import { PeerKind } from "../../../models/message_injection.js";
import { StrategyType, StrategyRole, NO_STRATEGY, type TeamStrategy, type GameStrategy } from "../../../models/game_strategy.js";
import { bfsDistancesFrom, posKey, manhattanDistance } from "../../../utils/metrics.js";
import { MapBeliefs } from "../../bdi/belief/modules/map_beliefs.js";
import { buildHolds } from "../holds.js";
import { findApproachPair } from "../roles/handoff_geometry.js";
import { createLogger, type Logger } from "../../../utils/logger.js";
import { config } from "../../../config.js";

/**
 * Deterministically assigns all agents to roles based on the chosen team strategy.
 *
 * Team strategies:
 *   ZONAL_RELAY  — one PICKUP_AGENT (sweeps the full spawn region, drops at the spawn-side edge tile)
 *                  + one DELIVER_AGENT (waits at the edge tile, ferries parcels to real deliveries).
 *                  Requires ≥2 agents and a valid spawnEdge; otherwise assigns nothing.
 *   OPPORTUNISTIC — arms the HandpassInitiator on both agents. Both search autonomously; the first
 *                   to pick up initiates a handshake handpass via the BDI-layer HandpassInitiator.
 *   NONE          — disarms handpass on both agents; active strategies lapse on their TTL.
 */
export class TeamStrategyAssigner {
    private readonly log: Logger;

    constructor(
        private readonly beliefs: Readonly<Beliefs>,
        private readonly comm: Communication,
        private readonly addInjectedDesire: (entry: InjectedDesire) => void,
        private readonly setGameStrategy: (strategy: GameStrategy) => void,
        private readonly armHandpass: (bonus: number | undefined, ttlMs: number) => void = () => {},
        private readonly disarmHandpass: () => void = () => {},
    ) {
        this.log = createLogger("coordination");
    }

    async applyTeamStrategy(strategy: TeamStrategy, ctx: { geometry: TeamGeometry; reports: Map<string, BeliefsReport>; bonus?: number }): Promise<string> {
        if (strategy === NO_STRATEGY) {
            this.disarmHandpass();
            await this.comm.broadcast(PeerKind.SetHandpassMode, { armed: false });
            this.log.debug("applyTeamStrategy: NONE — strategies will lapse on TTL");
            return JSON.stringify({ ok: true, strategy: NO_STRATEGY });
        }

        if (strategy === StrategyType.Opportunistic) {
            const ttlSeconds = Math.min(120, Math.ceil(config.coordination.intervalMs / 1000) * 2);
            this.armHandpass(ctx.bonus, ttlSeconds * 1_000);
            await this.comm.broadcast(PeerKind.SetHandpassMode, { armed: true, bonus: ctx.bonus ?? null, ttl_seconds: ttlSeconds });
            this.log.debug(`applyTeamStrategy: OPPORTUNISTIC armed, bonus=${ctx.bonus ?? 0}, ttl=${ttlSeconds}s`);
            return JSON.stringify({ ok: true, strategy: StrategyType.Opportunistic, bonus: ctx.bonus });
        }

        if (strategy !== StrategyType.ZonalRelay) return JSON.stringify({ error: `Unknown strategy: ${strategy}` });

        // Disarm opportunistic mode when switching to ZONAL_RELAY
        this.disarmHandpass();
        await this.comm.broadcast(PeerKind.SetHandpassMode, { armed: false });

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
        for (const [id, report] of ctx.reports) {
            if (report.pos) {
                roster.push({ id, pos: report.pos, bfs: bfsDistancesFrom(report.pos, walkable) });
            }
        }

        if (roster.length === 0) return JSON.stringify({ error: "No agents with known positions" });

        return this.assignZonalRelay(roster, ttlSeconds, ctx.geometry, ctx.bonus);
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
        geometry: TeamGeometry,
        bonus?: number,
    ): Promise<string> {
        if (roster.length < 2) {
            this.log.debug("ZONAL_RELAY: not enough agents — skipping assignment");
            return JSON.stringify({ ok: true, strategy: StrategyType.ZonalRelay, assignments: [] });
        }

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
        const deliverAgent = roster.find(a => a.id !== pickupMatch!.agentId);
        if (!deliverAgent) return JSON.stringify({ error: "No remaining agent for DELIVER_AGENT" });

        // Compute the meet tile as the midpoint between the chosen pickup anchor and the
        // nearest delivery cluster, snapped to the nearest reachable tile. This balances the
        // relay — PICKUP owns spawn→midpoint, DELIVER owns midpoint→delivery.
        const meetTile = this.computeRelayMeetTile(pickupMatch.anchor.pos, spawnEdge, geometry);

        // Compute distinct adjacent approach cells so each agent waits one step from M.
        const pickupAgent = roster.find(a => a.id === pickupMatch!.agentId)!;
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
        return JSON.stringify({ ok: true, strategy: StrategyType.ZonalRelay, assignments: results });
    }

    /**
     * Apply an AssignStrategy to a specific agent.
     * Self → apply locally via setGameStrategy.
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
     * Mirror of apply_injection.ts AssignStrategy case, but called locally by the strategy assigner.
     * Calls setGameStrategy; the RoleController in Intentions generates gated desires each cycle.
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
    }
}
