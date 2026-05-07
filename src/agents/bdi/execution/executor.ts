import type { Position } from "../../../models/position.js";
import type { Beliefs } from "../belief/beliefs.js";
import type { Planner } from "../plan/planner.js";
import type { Intentions } from "../intention/intentions.js";
import { generateDesires } from "../desire/desire_generator.js";

/**
 * Drives the action loop: retrieves the next step from the Planner, emits the corresponding
 * socket action, and reports success/failure back to the Planner.
 * After a successful move, it immediately rebuilds desires and replans so the agent can react
 * to position-sensitive preemptions (e.g. stepping onto a parcel) without waiting for the
 * next sensing event.
 */
export class Executor {
    private executing = false;

    constructor(
        private readonly socket: any,
        private readonly beliefs: Beliefs,
        private readonly intentions: Intentions,
        private readonly planner: Planner,
        private readonly debug: boolean,
    ) {}

    /**
     * Pick up the parcel at the given position and update beliefs on success.
     * @returns true if the pickup succeeded.
     */
    private async handlePickup(pos: Position): Promise<boolean> {
        const ack = await this.socket.emitPickup() as Array<{ id?: string; parcelId?: string }> | null;
        if (ack === null) return false;
        const parcel = this.beliefs.parcels.getParcelAt(pos);
        if (parcel) this.beliefs.parcels.markPickup(parcel);
        return true;
    }

    /**
     * Put down all carried parcels and update beliefs on success.
     * @returns true if the putdown succeeded.
     */
    private async handlePutdown(meId: string): Promise<boolean> {
        const ack = await this.socket.emitPutdown() as Array<{ id: string }>;
        if (ack.length === 0) return false;
        this.beliefs.parcels.cleanDeliveredParcels(this.beliefs.parcels.getCarriedByAgent(meId));
        return true;
    }

    /**
     * Move one tile in the given direction and update the agent's position on success.
     * @returns true if the move succeeded.
     */
    private async handleMove(direction: string): Promise<boolean> {
        const result = await this.socket.emitMove(direction) as Position | false;
        if (result === false) return false;
        this.beliefs.agents.updateMyPosition(result);
        return true;
    }

    /**
     * Execute one step of the current plan.
     * @returns true if a plan is still active after this step.
     */
    async execute(): Promise<boolean> {
        const me = this.beliefs.agents.getCurrentMe();
        if (!me?.lastPosition) return false;
        const currentPosition = me.lastPosition;

        const plan = this.planner.plan(); // Ensure we have a plan before trying to execute; no-op if already planned for current intentions.
        if (!plan) {
            // Let the executor explain why there's nothing to do when PDDL is in-flight.
            if (this.debug)
                console.log("[EXECUTE] Waiting...");
            return false;
        }

        // Get the next step; "wait" means an agent is blocking our tile, null means no safe move.
        const step = this.planner.nextStep(currentPosition);
        if (step === "wait") {
            if (this.debug) console.log("[EXECUTE] Waiting for blocked tile to clear.");
            return false;
        }
        if (step === null) {
            if (this.debug) console.log("[EXECUTE] No safe step to execute.");
            return false;
        }

        if (this.debug) console.log("[EXECUTE] Step:", step);

        let succeeded: boolean;
        if (step.kind === "pickup") succeeded = await this.handlePickup(currentPosition);
        else if (step.kind === "putdown") succeeded = await this.handlePutdown(me.id);
        else succeeded = await this.handleMove(step.direction);

        if (succeeded) {
            this.planner.advance();
            // Rebuild desires immediately — CLEAR_CRATE flows in via intentions.crateDesires
            // so no manual injection is needed here.
            const desires = generateDesires(this.beliefs);
            this.intentions.update(this.beliefs, desires);
            this.planner.plan();
        } else {
            this.planner.invalidate();
        }

        return plan !== null;
    }

    async start(): Promise<void> {
        if (this.executing) return;
        this.executing = true;
        try {
            while (this.executing) {
                const shouldContinue = await this.execute();
                if (!shouldContinue) await new Promise(r => setTimeout(r, 200));
            }
        } catch (err) {
            if (this.debug) console.error("[EXECUTE] Execution error:", err);
        } finally {
            this.executing = false;
        }
    }
}
