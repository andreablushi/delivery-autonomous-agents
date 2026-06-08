import type { Beliefs } from "../../bdi/belief/beliefs.js";
import type { GameStrategy } from "../../../models/game_strategy.js";
import type { GeneratedDesires } from "../../../models/desires.js";

/** Interface for a role finite state machine */
export interface RoleFSM<S extends string> {
    readonly state: S;
    /** Helper to reset the role state */
    reset(): void;
    /** Define the state transition logic */
    tick(beliefs: Beliefs, strategy: GameStrategy): void;
    /** Build desires for the current state */
    buildDesires(beliefs: Beliefs, strategy: GameStrategy): GeneratedDesires;
}
