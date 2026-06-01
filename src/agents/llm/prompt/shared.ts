import { readFileSync } from "fs";
import { join } from "path";

const cache = new Map<string, string>();

/**
 * Render a prompt template with the given variables.
 * @param dir  Absolute directory where the template file lives (use `dirname(fileURLToPath(import.meta.url))`).
 * @param name Name of the template file (without .txt extension).
 * @param vars Variables to replace in the template.
 * @returns The rendered prompt string.
 */
export function render(dir: string, name: string, vars: Record<string, string>): string {
    const key = join(dir, name);
    if (!cache.has(key)) {
        cache.set(key, readFileSync(join(dir, `${name}.txt`), "utf-8"));
    }
    return cache.get(key)!.replace(/\{\{(\w+)\}\}/g, (_, k) => {
        if (!(k in vars)) throw new Error(`Template "${name}.txt" has unknown placeholder: {{${k}}}`);
        return vars[k];
    });
}
