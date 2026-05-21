export function coerceNum(v: unknown): unknown {
    return typeof v === "string" && v.trim() !== "" ? Number(v) : v;
}
