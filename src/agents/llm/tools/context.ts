import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { InjectedIntention } from "../../../models/intentions.js";
import type { DesireType } from "../../../models/desires.js";
import type { Communication } from "../../communication/communication.js";
import type { RuleStore } from "../../bdi/desire/rule_store.js";

export interface ToolContext {
    beliefs: Beliefs;
    addInjectedIntention: (entry: InjectedIntention) => void;
    removeIntentionsByType: (type: DesireType["type"]) => void;
    comm: Communication;
    sourceId: string;
    ruleStore: RuleStore;
    /** Trigger an immediate team coordination round (no-op if no coordinator is active). */
    requestTeamStatus?: () => void;
    /** Run the two-phase rendezvous commit protocol; returns a JSON result string. */
    proposeRendezvous?: (rawArgs: unknown) => Promise<string>;
    /** Run the two-phase red-light commit protocol; returns a JSON result string. */
    proposeRedLight?: (rawArgs: unknown) => Promise<string>;
}
