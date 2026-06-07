import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { BeliefsReport } from "../../../models/message_injection.js";
import { config } from "../../../config.js";

export const POSTURES = ["ZONAL_RELAY", "OPPORTUNISTIC", "NONE"] as const;
export type Posture = typeof POSTURES[number];

/**
 * Tracks team score gains per cooperation posture using a bounded sliding window.
 * Called once per cooperation round to sample performance and expose it to the LLM prompt.
 */
export class PerformanceTracker {
    private readonly recentGains = new Map<Posture, number[]>(POSTURES.map(p => [p, []]));
    private lastPosture: Posture | null = null;
    private lastTeamScore: number | null = null;

    /** Record which posture was just applied so the next sample can attribute the delta to it. */
    markActive(posture: Posture): void {
        this.lastPosture = posture;
    }

    /**
     * Sample the current team score and attribute the delta to the posture that was active
     * during the elapsed interval. Call once per round, after fresh reports are collected.
     */
    sample(freshReports: Map<string, BeliefsReport>, beliefs: Readonly<Beliefs>): void {
        const myScore = beliefs.agents.getCurrentMe()?.score ?? 0;
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

    /** Format per-posture stats for injection into the LLM cooperation prompt. */
    format(): string {
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
}
