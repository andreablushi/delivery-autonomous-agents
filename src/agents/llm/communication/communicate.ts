import { encode, type PeerInjectionKind } from "../../../models/envelope.js";
import type { ToolContext } from "../tools/context.js";
import type { Messenger } from "../../bdi/communication/messenger.js";
import { createLogger } from "../../../utils/logger.js";

const log = createLogger("communication");

/**
 * Send a peer injection message to all current friends, containing the specified tool call.
 * This allows the LLM agent to inject intentions into other agents by broadcasting a message that encodes the tool call, which other agents can decode and convert into intentions on their side.
 * @param ctx The tool context, containing beliefs, messenger, and rule store
 * @param tool The name of the tool being called (e.g. "register_scoring_rule")
 * @param args The raw arguments of the tool call, which will be included in the message for other agents to decode
 */
export async function communicate(
    ctx: ToolContext,
    tool: PeerInjectionKind,
    args: Record<string, unknown>,
): Promise<void> {
    const friends = ctx.beliefs.agents.getCurrentFriends();
    if (friends.length === 0) {
        log.debug("no friend sensed, skip communication for", tool);
        return;
    }
    const msg = encode({ v: 1, kind: "peer_injection", tool, args });
    for (const friend of friends) {
        await ctx.messenger.say(friend.id, msg);
    }
}

/**
 * Send a peer injection message to a single specific agent.
 * @param messenger Messenger to use for sending the message.
 * @param toId Socket ID of the target agent.
 * @param tool The peer injection tool kind.
 * @param args Arguments for the tool.
 */
export async function communicateTo(
    messenger: Messenger,
    toId: string,
    tool: PeerInjectionKind,
    args: Record<string, unknown>,
): Promise<void> {
    const msg = encode({ v: 1, kind: "peer_injection", tool, args });
    await messenger.say(toId, msg);
}
