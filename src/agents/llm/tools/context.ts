import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { PersistentDesireEntry } from "../../../models/intentions.js";
import type { Messenger } from "../../bdi/communication/messenger.js";

export interface ToolContext {
    beliefs: Beliefs;
    addPersistentDesire: (entry: PersistentDesireEntry) => void;
    messenger: Messenger;
    sourceId: string;
}
