import type { Position } from "../../../models/position.js";
import type { Parcel } from "../../../models/parcel.js";
import type { Beliefs } from "../belief/beliefs.js";
import type { RuleStore } from "../belief/rule_store.js";
import type { Planner } from "../plan/planner.js";
import type { Intentions } from "../intention/intentions.js";
import { createLogger, type Logger } from "../../../utils/logger.js";
import { config } from "../../../config.js";

/**
 * Drives the action loop: retrieves the next step from the Planner, emits the corresponding
 * socket action, and reports success/failure back to the Planner.
 */
export class Executor {
    private executing = false;
    /** Resolver for the kick-promise currently parked in the idle wait, or null when not idle. */
    private kickResolver: (() => void) | null = null;
    private readonly log: Logger;

    constructor(
        private readonly socket: any,
        private readonly beliefs: Beliefs,
        private readonly intentions: Intentions,
        private readonly planner: Planner,
        private readonly ruleStore: RuleStore,
        agentId?: string,
    ) {
        this.log = createLogger("execute", agentId);
    }

    /**
     * Pick up the parcel at the given position and update beliefs on success.
     * Uses ack IDs (not position) so belief updates survive the race where a sensing
     * event nulls the parcel's lastPosition while awaiting the ack.
     * @param pos Current agent position — used to set `lastPosition` on the picked-up parcel.
     * @param agentId ID of the agent performing the pickup — written to `carriedBy`.
     * @returns true if at least one parcel was picked up.
     */
    private async handlePickup(pos: Position, agentId: string): Promise<boolean> {
        const ack = await this.socket.emitPickup() as Array<{ id?: string }> | null;
        if (ack === null) return false;
        for (const { id } of ack) {
            if (!id) continue;
            // Merge with existing belief if present, otherwise create a minimal stub.
            const existing = this.beliefs.parcels.getCurrentParcels().find(p => p.id === id);
            const parcel: Parcel = existing
                ? { ...existing, lastPosition: pos, carriedBy: agentId }
                : { id, lastPosition: pos, carriedBy: agentId, reward: 1 };
            this.beliefs.parcels.markPickup(parcel);
        }
        return true;
    }

    /**
     * Put down all carried parcels and update beliefs on success.
     * @param meId Agent ID — used to resolve which parcels to mark as delivered.
     * @returns true if at least one parcel was put down.
     */
    private async handlePutdown(meId: string): Promise<boolean> {
        const ack = await this.socket.emitPutdown() as Array<{ id: string }>;
        if (ack.length === 0) return false;
        this.beliefs.parcels.cleanDeliveredParcels(this.beliefs.parcels.getCarriedByAgent(meId));
        return true;
    }

    /**
     * Move one tile in the given direction and update the agent's position on success.
     * `emitMove` blocks until the server acks the move (after `movement_duration` ms),
     * so this call naturally rate-limits the action loop to the server's movement cadence.
     * @param direction One of "up" | "down" | "left" | "right".
     * @returns true if the move was accepted by the server.
     */
    private async handleMove(direction: string): Promise<boolean> {
        const result = await this.socket.emitMove(direction) as Position | false;
        if (result === false) return false;
        // Optimistically update position from the ack rather than waiting for the next 'you' event.
        this.beliefs.agents.updateMyPosition(result);
        return true;
    }

    /**
     * Attempt to execute the next step of the current plan.
     *
     * Flow:
     * 1. Ensure a plan exists (`planner.plan()` is a no-op if one is already live).
     * 2. Ask the planner for the next step — "wait" (blocked tile), null (no safe move), or an action.
     * 3. Dispatch to the appropriate handler and report success/failure back to the planner.
     * 4. On success: advance the plan pointer and eagerly replan so the next call sees fresh state.
     * 5. On failure: invalidate the plan so the next call rebuilds from scratch.
     *
     * @returns true if a plan was active going into this call (used by `start()` to decide
     *          whether to idle or loop immediately).
     */
    async execute(): Promise<boolean> {
        const me = this.beliefs.agents.getCurrentMe();
        if (!me?.lastPosition) return false;
        const currentPosition = me.lastPosition;

        // Ensure we have a plan; no-op if one is already live for the current intention head.
        const plan = await this.planner.plan();
        if (!plan) {
            // Refresh intentions so the next tick sees an up-to-date queue without waiting for sensing.
            this.intentions.update(this.beliefs, this.ruleStore);
            this.log.debug("No plan to execute.");
            return false;
        }

        // "wait": an agent is blocking the next tile
        const step = this.planner.nextStep(currentPosition);
        if (step === "wait") {
            this.log.debug("Waiting for blocked tile to clear.");
            return false;
        }
        // null: no safe path to the target (e.g. blocked by a wall or enemy)
        if (step === null) {
            this.log.debug("No safe step to execute.");
            return false;
        }

        this.log.debug("Step:", step);

        let succeeded: boolean;
        if (step.kind === "pickup") succeeded = await this.handlePickup(currentPosition, me.id);
        else if (step.kind === "putdown") succeeded = await this.handlePutdown(me.id);
        else succeeded = await this.handleMove(step.direction);

        if (succeeded) {
            this.log.debug("Step succeeded.");
            this.planner.advance();
            // Eagerly rebuild desires and replan so position-sensitive preemptions
            this.intentions.update(this.beliefs, this.ruleStore);
            await this.planner.plan();
        } else {
            this.log.debug("Step failed, invalidating plan.");
            this.planner.invalidate();
        }

        return plan !== null;
    }

    /**
     * Wake the executor if it is currently sleeping in the idle wait.
     * Called by the `'sensing'` listener in `BDIAgent` so fresh perceptions cut the idle
     * delay short instead of burning the remainder of the clock tick.
     * Safe to call at any time — no-op when the executor is not idle.
     */
    kick(): void {
        this.kickResolver?.();
        this.kickResolver = null;
    }

    /**
     * Start the execution loop. Idempotent — subsequent calls while already running are no-ops.
     *
     * Each iteration calls `execute()`:
     * - If a step was taken (or attempted), loop immediately.
     * - If idle (no plan / blocked / no safe move), sleep for one server clock tick
     *   (`beliefs.settings.clock`) before retrying. The sleep races against `kick()` so an
     *   incoming sensing event can cut it short.
     */
    async start(): Promise<void> {
        if (this.executing) return;
        this.executing = true;
        try {
            while (this.executing) {
                const shouldContinue = await this.execute();

                if (!shouldContinue) {
                    // Idle wait: sleep for one server clock tick, or until kick() fires.
                    const ms = this.beliefs.settings?.clock ?? config.execution.defaultClockTickMs;
                    await Promise.race([
                        new Promise<void>(r => setTimeout(r, ms)),
                        new Promise<void>(r => { this.kickResolver = r; }),
                    ]);
                    this.kickResolver = null;
                }
            }
        } catch (err) {
            this.log.error("Execution error:", err);
        } finally {
            this.executing = false;
        }
    }
}
