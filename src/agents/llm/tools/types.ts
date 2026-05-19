export type RequestGotoArgs = {
    target_x: number;
    target_y: number;
    reward: number;
    ttl_seconds: number;
};

export function parseRequestGotoArgs(json: unknown): RequestGotoArgs | { error: string } {
    if (typeof json !== "object" || json === null) return { error: "args must be an object" };
    const obj = json as Record<string, unknown>;
    const { target_x, target_y, reward, ttl_seconds } = obj;
    if (typeof target_x !== "number" || !Number.isInteger(target_x))
        return { error: "target_x must be an integer" };
    if (typeof target_y !== "number" || !Number.isInteger(target_y))
        return { error: "target_y must be an integer" };
    if (typeof reward !== "number" || !Number.isInteger(reward) || reward < 1)
        return { error: "reward must be an integer >= 1" };
    if (typeof ttl_seconds !== "number" || !Number.isInteger(ttl_seconds) || ttl_seconds < 5 || ttl_seconds > 120)
        return { error: "ttl_seconds must be an integer in [5, 120]" };
    return { target_x, target_y, reward, ttl_seconds };
}
