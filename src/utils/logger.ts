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

const COLORS = ["\x1b[36m", "\x1b[33m", "\x1b[32m", "\x1b[35m", "\x1b[34m", "\x1b[31m", "\x1b[96m", "\x1b[93m"];
const RESET = "\x1b[0m";

function pickColor(namespace: string): string {
    let hash = 0;
    for (let i = 0; i < namespace.length; i++) hash = (hash * 31 + namespace.charCodeAt(i)) >>> 0;
    return COLORS[hash % COLORS.length];
}

const raw = (process.env._DEBUG ?? "").trim();
const tokens = raw.split(",").map(t => t.trim().toLowerCase()).filter(t => t.length > 0);
const wildcard = tokens.includes("*");
const enabled = new Set(tokens);

// Check if a namespace is enabled based on the DEBUG env var
function isEnabled(namespace: string): boolean {
    return wildcard || enabled.has(namespace.toLowerCase());
}

// Logger interface with methods for different log levels
export interface Logger {
    debug(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}

const noop = () => {};

/**
 * Create a logger for a given namespace and optional agentId.
 * @param namespace Namespace for this logger (e.g. "plan", "execute")
 * @param agentId Optional agent ID for competitive mode (e.g. "agent-1234")
 * @returns A Logger instance with methods debug, info, warn, error
 */
export function createLogger(namespace: string, agentId?: string): Logger {
    const color = pickColor(namespace);
    const tag = `${color}[${namespace}]${RESET}`;
    const prefix = agentId ? `${color}[${agentId}]${RESET}${tag}` : tag;
    const on = isEnabled(namespace);

    return {
        debug: on ? (...args) => console.log(prefix, ...args) : noop,
        info:  on ? (...args) => console.log(prefix, ...args) : noop,
        warn:  (...args) => console.warn(prefix, ...args),
        error: (...args) => console.error(prefix, ...args),
    };
}
