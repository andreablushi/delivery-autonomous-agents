import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { InjectedIntention } from "../../../models/intentions.js";
import type { Messenger } from "../../bdi/communication/messenger.js";
import type { RuleStore } from "../../bdi/belief/rule_store.js";

export interface ToolContext {
    beliefs: Beliefs;
    addInjectedIntention: (entry: InjectedIntention) => void;
    messenger: Messenger;
    sourceId: string;
    ruleStore: RuleStore;
}
