import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const PROMPT_DIR = dirname(fileURLToPath(import.meta.url));
const cache = new Map<string, string>();

/**
 * Renders a prompt template with the given variables. Templates are cached after the first read for efficiency.
 * @param name The name of the template file (without .txt extension) located in the same directory as this module.
 * @param vars The variables to substitute into the template.
 * @returns The rendered prompt.
 */
function renderTemplate(name: string, vars: Record<string, string>): string {
    if (!cache.has(name)) {
        cache.set(name, readFileSync(join(PROMPT_DIR, `${name}.txt`), "utf-8"));
    }
    return cache.get(name)!.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        if (!(key in vars)) throw new Error(`Template "${name}.txt" has unknown placeholder: {{${key}}}`);
        return vars[key];
    });
}

/**
 * Builds the system prompt that sets the behavior and constraints for the LLM. This is static and does not include dynamic context.
 * @returns The system prompt string.
 */
export function buildSystemPrompt(): string {
        return renderTemplate("system", {});
    }

/**
 * Builds the user message prompt that includes the incoming message and current beliefs as context. This is dynamic and constructed for each message.
 * @param args The arguments to include in the user message, such as sender info, content, and context.
 * @returns The user message prompt string.
 */
export function buildUserMessage(args: {
    senderName: string;
    senderId: string;
    content: string;
    context: string;
}): string {
    return renderTemplate("user_message", args);
}
