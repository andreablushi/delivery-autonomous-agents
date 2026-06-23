import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { Communication } from "../../communication/communication.js";
import type { AgentControl } from "../../../models/agent_control.js";

export interface ToolContext extends Pick<AgentControl,
    "ruleStore" | "addInjectedDesire" | "removeInjectedDesiresByType" | "setGameStrategy" | "getGameStrategy"
> {
    beliefs: Beliefs;
    comm: Communication;
    sourceId: string;
    /** Run the two-phase rendezvous commit protocol; returns a JSON result string. */
    proposeRendezvous?: (rawArgs: unknown) => Promise<string>;
    /** Run the two-phase red-light commit protocol; returns a JSON result string. */
    proposeRedLight?: (rawArgs: unknown) => Promise<string>;
    /** Run the two-phase goto commit protocol for a specific teammate; returns a JSON result string. */
    proposeGoto?: (agentId: string, rawArgs: unknown) => Promise<string>;
}
