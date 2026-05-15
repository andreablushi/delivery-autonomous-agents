/**
 * Tiny namespaced logger.
 *
 * Enable namespaces via the DEBUG env var (comma-separated, `*` for all):
 *   DEBUG=plan,execute
 *   DEBUG=*
 *
 * `debug` and `info` are gated by namespace; `warn` and `error` are always emitted.
 * In competitive mode, pass an agentId so interleaved stdout can be demuxed.
 */

const raw = (process.env.DEBUG ?? "").trim();
const tokens = raw.split(",").map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
const wildcard = tokens.includes("*");
const enabled = new Set(tokens);

function isEnabled(namespace: string): boolean {
    return wildcard || enabled.has(namespace.toLowerCase());
}

export interface Logger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}

const noop = () => {};

export function createLogger(namespace: string, agentId?: string): Logger {
    const prefix = agentId ? `[${agentId}][${namespace}]` : `[${namespace}]`;
    const on = isEnabled(namespace);

    return {
        debug: on ? (...args) => console.log(prefix, ...args) : noop,
        info:  on ? (...args) => console.log(prefix, ...args) : noop,
        warn:  (...args) => console.warn(prefix, ...args),
        error: (...args) => console.error(prefix, ...args),
    };
}
