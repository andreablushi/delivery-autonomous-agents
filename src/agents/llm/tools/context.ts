import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { InjectedIntention } from "../../../models/intentions.js";
import type { DesireType } from "../../../models/desires.js";
import type { Messenger } from "../../bdi/communication/messenger.js";
import type { RuleStore } from "../../bdi/belief/rule_store.js";

export interface ToolContext {
    beliefs: Beliefs;
    addInjectedIntention: (entry: InjectedIntention) => void;
    removeIntentionsByType: (type: DesireType["type"]) => void;
    messenger: Messenger;
    sourceId: string;
    ruleStore: RuleStore;
    /** Trigger an immediate team coordination round (no-op if no coordinator is active). */
    requestTeamStatus?: () => void;
}
