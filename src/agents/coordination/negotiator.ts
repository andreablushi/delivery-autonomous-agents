import type { Beliefs } from "../bdi/belief/beliefs.js";
import type { Communication } from "../communication/communication.js";
import type { InjectedDesire } from "../../models/desires.js";
import { PeerKind, type PeerInjectionKind } from "../../models/message_injection.js";
import { parseRendezvousArgs, parseRedLightArgs, parseGotoArgs } from "../../models/injection_args.js";
import { buildRendezvousHolds, buildHolds } from "../cooperation/holds.js";
import { createLogger, type Logger } from "../../utils/logger.js";
import { config } from "../../config.js";
import type { PeerInbox } from "./peer_inbox.js";

/**
 * Runs two-phase commit negotiations for cooperative actions: goto, rendezvous, and red-light.
 *
 * Phase 1 — broadcast a proposal to all teammates (or a specific subset).
 * Phase 2 — wait commitWindowMs; if every addressed peer voted yes for this roundId,
 *            broadcast commit and call onCommit(); otherwise broadcast abort.
 */
export class Negotiator {
    private readonly log: Logger;

    constructor(
        private readonly beliefs: Readonly<Beliefs>,
        private readonly comm: Communication,
        private readonly inbox: PeerInbox,
        private readonly addInjectedDesire: (entry: InjectedDesire) => void,
    ) {
        this.log = createLogger("coordination");
    }

    async proposeGoto(agentId: string, rawArgs: unknown): Promise<string> {
        const p = parseGotoArgs(rawArgs);
        if ("error" in p) return JSON.stringify(p);
        if (!this.beliefs.map.checkMapBounds(p.target_x, p.target_y)) return JSON.stringify({ error: "Coordinates out of map bounds" });
        if (!this.beliefs.agents.getTeammateIds().has(agentId)) return JSON.stringify({ error: `Agent ${agentId} is not a known teammate` });
        const roundId = `goto-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        return this.runTwoPhaseCommit({
            label: "Goto", roundId,
            proposeKind: PeerKind.GotoPropose, commitKind: PeerKind.GotoCommit, abortKind: PeerKind.GotoAbort,
            proposeArgs: { roundId, target_x: p.target_x, target_y: p.target_y, reward: p.reward, ttl_seconds: p.ttl_seconds },
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
        const roundId = `rdv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const selfHolds = buildRendezvousHolds(this.beliefs as Beliefs, from, center, p.max_distance, p.reward, {
            releaseZone: { center, maxDistance: p.max_distance },
            rendezvousId: roundId,
            sourceId: "coordinator",
        });
        if (selfHolds.length === 0) return JSON.stringify({ error: "No reachable tile within rendezvous zone for self" });
        return this.runTwoPhaseCommit({
            label: "Rendezvous", roundId,
            proposeKind: PeerKind.RendezvousPropose, commitKind: PeerKind.RendezvousCommit, abortKind: PeerKind.RendezvousAbort,
            proposeArgs: { roundId, x: p.x, y: p.y, max_distance: p.max_distance, reward: p.reward },
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
        const roundId = `rl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        return this.runTwoPhaseCommit({
            label: "Red light", roundId,
            proposeKind: PeerKind.RedLightPropose, commitKind: PeerKind.RedLightCommit, abortKind: PeerKind.RedLightAbort,
            proposeArgs: { roundId, reward: p.reward, ttl_seconds: p.ttl_seconds, axis: p.axis, parity: p.parity },
            onCommit: () => {
                const expiresAt = Date.now() + p.ttl_seconds * 1_000;
                const holds = buildHolds(selfTiles, p.reward, { sourceId: "coordinator", expiresAt });
                for (const hold of holds) this.addInjectedDesire(hold);
            },
        });
    }

    private async runTwoPhaseCommit(opts: {
        label: string;
        roundId: string;
        proposeKind: Exclude<PeerInjectionKind, "beliefs_report">;
        commitKind: Exclude<PeerInjectionKind, "beliefs_report">;
        abortKind: Exclude<PeerInjectionKind, "beliefs_report">;
        proposeArgs: Record<string, unknown>;
        onCommit: () => void;
        /** Subset of peers to address. Defaults to all teammates. */
        recipients?: string[];
    }): Promise<string> {
        const { label, roundId, proposeKind, commitKind, abortKind, proposeArgs, onCommit } = opts;
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

        if (this.inbox.allAccepted(teammateIds, roundId, sentAt)) {
            this.log.debug(`${label} ${roundId}: all peers accepted — committing`);
            for (const id of teammateIds) {
                await this.comm.send(id, commitKind, proposeArgs);
            }
            onCommit();
            return JSON.stringify({ ok: true });
        } else {
            this.log.debug(`${label} ${roundId}: not all peers accepted — aborting`);
            for (const id of teammateIds) {
                await this.comm.send(id, abortKind, { roundId });
            }
            return JSON.stringify({ ok: false, reason: `${label} rejected: not all peers accepted` });
        }
    }
}
