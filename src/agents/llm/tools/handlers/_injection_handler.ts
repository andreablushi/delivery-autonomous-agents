import type { ToolContext } from "../context.js";
import { applyInjection } from "../../../../models/apply_injection.js";
import type { PeerInjectionKind } from "../../../../models/message_injection.js";

type BroadcastKind = Exclude<PeerInjectionKind, "beliefs_report">;

/**
 * Creates a standard inject-then-broadcast execute handler.
 * Applies the injection locally, then broadcasts to all teammates.
 * @param kind     The PeerKind for both the local injection and the broadcast.
 * @param mkArgs   Optional override for the broadcast payload; defaults to rawArgs cast to Record.
 */
export function makeInjectionExecute(
    kind: BroadcastKind,
    mkArgs?: (rawArgs: unknown) => Record<string, unknown>,
): (rawArgs: unknown, ctx: ToolContext) => Promise<string> {
    return async (rawArgs, ctx) => {
        const r = applyInjection(kind, rawArgs, ctx);
        if ("error" in r) return JSON.stringify(r);
        await ctx.comm.broadcast(kind, mkArgs ? mkArgs(rawArgs) : rawArgs as Record<string, unknown>);
        return JSON.stringify({ ok: true });
    };
}
