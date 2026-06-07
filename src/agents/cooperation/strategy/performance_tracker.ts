import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { BeliefsReport } from "../../../models/message_injection.js";
import { TEAM_STRATEGIES, type TeamStrategy } from "../../../models/game_strategy.js";
import { config } from "../../../config.js";

/**
 * Tracks team score gains per team strategy using a bounded sliding window.
 * Called once per cooperation round to sample performance and expose it to the LLM prompt.
 */
export class PerformanceTracker {
    private readonly recentGains = new Map<TeamStrategy, number[]>(TEAM_STRATEGIES.map(s => [s, []]));
    private lastStrategy: TeamStrategy | null = null;
    private lastTeamScore: number | null = null;

    /** Record which strategy was just applied so the next sample can attribute the delta to it. */
    markActive(strategy: TeamStrategy): void {
        this.lastStrategy = strategy;
    }

    /**
     * Sample the current team score and attribute the delta to the strategy that was active
     * during the elapsed interval. Call once per round, after fresh reports are collected.
     */
    sample(freshReports: Map<string, BeliefsReport>, beliefs: Readonly<Beliefs>): void {
        const myScore = beliefs.agents.getCurrentMe()?.score ?? 0;
        const teammateScore = Array.from(freshReports.values()).reduce((s, r) => s + r.score, 0);
        const teamScore = myScore + teammateScore;

        if (this.lastTeamScore !== null && this.lastStrategy !== null) {
            const delta = teamScore - this.lastTeamScore;
            const window = this.recentGains.get(this.lastStrategy)!;
            window.push(delta);
            if (window.length > config.coordination.perfWindowRounds) window.shift();
        }
        this.lastTeamScore = teamScore;
    }

    /** Format per-strategy stats for injection into the LLM cooperation prompt. */
    format(): string {
        const lines: string[] = [];
        for (const strategy of TEAM_STRATEGIES) {
            const gains = this.recentGains.get(strategy)!;
            if (gains.length === 0) {
                lines.push(`${strategy}: no data yet`);
            } else {
                const avg = gains.reduce((s, g) => s + g, 0) / gains.length;
                const latest = gains[gains.length - 1];
                const sign = (n: number) => n >= 0 ? `+${n.toFixed(1)}` : n.toFixed(1);
                lines.push(`${strategy}: avg ${sign(avg)}/round (last ${gains.length}, latest ${sign(latest)})`);
            }
        }
        lines.push(`Current: ${this.lastStrategy ?? "none"}`);
        return lines.join("\n");
    }
}
