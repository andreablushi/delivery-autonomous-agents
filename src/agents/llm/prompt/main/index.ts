import { fileURLToPath } from "url";
import { dirname } from "path";
import type { Beliefs } from "../../../bdi/belief/beliefs.js";
import type { RuleStore } from "../../../bdi/belief/rule_store.js";
import { render } from "../shared.js";

const DIR = dirname(fileURLToPath(import.meta.url));

/** Build the system prompt that sets up the LLM's role and instructions. */
export function buildSystemPrompt(): string {
    return render(DIR, "system", {});
}

/**
 * Build the user message that includes the incoming message content and current beliefs.
 * @param args.senderName Name of the message sender
 * @param args.senderId   ID of the message sender
 * @param args.content    The message content to process
 * @param args.beliefs    Current belief state (summarized internally)
 * @param args.ruleStore  Active scoring rules (formatted internally)
 */
export function buildUserMessage(args: {
    senderName: string;
    senderId: string;
    content: string;
    beliefs: Readonly<Beliefs>;
    ruleStore: RuleStore;
}): string {
    const context = [args.beliefs.summarize(), args.ruleStore.format()].filter(Boolean).join("\n");
    return render(DIR, "user_message", {
        senderName: args.senderName,
        senderId: args.senderId,
        content: args.content,
        context,
    });
}
