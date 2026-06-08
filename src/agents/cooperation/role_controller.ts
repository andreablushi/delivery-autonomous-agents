import type { Beliefs } from "../bdi/belief/beliefs.js";
import type { GameStrategy } from "../../models/game_strategy.js";
import type { GeneratedDesires } from "../../models/desires.js";
import { StrategyType, StrategyRole } from "../../models/game_strategy.js";
import { createLogger } from "../../utils/logger.js";
import { PickupRole } from "./roles/pickup_role.js";
import { DeliverRole } from "./roles/deliver_role.js";
import { PasserRole } from "./roles/passer_role.js";
import { ReceiverRole } from "./roles/receiver_role.js";

/** Controls the roles of agents in the team. */
export class RoleController {
    private lastRole: string | null = null;
    private lastPartnerId: string | undefined = undefined;
    private readonly pickup: PickupRole;
    private readonly deliver: DeliverRole;
    private readonly passer: PasserRole;
    private readonly receiver: ReceiverRole;

    constructor(agentId?: string) {
        const log = createLogger("coordination", agentId);
        this.pickup = new PickupRole(log);
        this.deliver = new DeliverRole(log);
        this.passer = new PasserRole(log);
        this.receiver = new ReceiverRole(log);
    }

    reset(): void {
        this.pickup.reset();
        this.deliver.reset();
        this.passer.reset();
        this.receiver.reset();
        this.lastRole = null;
        this.lastPartnerId = undefined;
    }

    sync(strategy: GameStrategy): void {
        const changed = strategy.role !== this.lastRole || strategy.partnerId !== this.lastPartnerId;
        if (changed) {
            this.pickup.reset();
            this.deliver.reset();
            this.passer.reset();
            this.receiver.reset();
            this.lastRole = strategy.role;
            this.lastPartnerId = strategy.partnerId;
        }
    }

    tick(beliefs: Beliefs, strategy: GameStrategy): void {
        switch (strategy.strategy) {
            case StrategyType.ZonalRelay:
                if (strategy.role === StrategyRole.PickupAgent) this.pickup.tick(beliefs, strategy);
                else this.deliver.tick(beliefs, strategy);
                break;
            case StrategyType.Opportunistic:
                if (strategy.role === StrategyRole.Passer) this.passer.tick(beliefs, strategy);
                else this.receiver.tick(beliefs, strategy);
                break;
            default: {
                const _exhaustive: never = strategy;
                break;
            }
        }
    }

    buildDesires(beliefs: Beliefs, strategy: GameStrategy): GeneratedDesires {
        switch (strategy.strategy) {
            case StrategyType.ZonalRelay:
                if (strategy.role === StrategyRole.PickupAgent) return this.pickup.buildDesires(beliefs, strategy);
                else return this.deliver.buildDesires(beliefs, strategy);
            case StrategyType.Opportunistic:
                if (strategy.role === StrategyRole.Passer) return this.passer.buildDesires(beliefs, strategy);
                else return this.receiver.buildDesires(beliefs, strategy);
            default: {
                const _exhaustive: never = strategy;
                return new Map();
            }
        }
    }

    /** Returns true when the current role's FSM has reached its terminal state. */
    isComplete(strategy: GameStrategy): boolean {
        switch (strategy.strategy) {
            case StrategyType.ZonalRelay:    return false; // relay roles loop continuously
            case StrategyType.Opportunistic:
                if (strategy.role === StrategyRole.Passer) return this.passer.isComplete();
                else return this.receiver.isComplete();
            default: {
                const _exhaustive: never = strategy;
                return false;
            }
        }
    }
}
