import type { Parcel } from "../../../../models/parcel.js";
import type { IOParcel } from "../../../../models/djs.js";
import type { Position } from "../../../../models/position.js";
import { Tracker } from "../collections/tracker.js";
import { ParcelSettings } from "../../../../models/game_configs.js";
import { config } from "../../../../config.js";

/**
 * Beliefs about parcels in the environment.
 */
export class ParcelBeliefs {

    private parcels = new Tracker<Parcel>();                // Latest-only store; eviction is handled by the decay logic via delete()
    private parcelSettings: ParcelSettings | null = null;   // Parcel settings from config
    private readonly carriedByMe = new Set<string>();       // IDs of parcels explicitly picked up by this agent

    private lastScoreUpdate = 0;                            // Timestamp of the last score update, used to trigger reward decay
    private lastDecayApplied = new Map<string, number>();   // Per-parcel decay clock: parcelId → timestamp decay last advanced to
    private recentlyDropped = new Map<string, number>();    // parcelId → expiry epoch ms; suppresses re-pickup after a drop
    
    /**
     * Update parcel settings belief with the latest config info.
     * @param settings 
     * @return void
     */
    setSettings(settings: ParcelSettings): void {
        this.parcelSettings = settings;
    }

    /**
     * Update parcel beliefs with the latest observed parcels.
     * @param parcels Array of parcels from the server, converted to internal Parcels type and stored in memory.
     * @param sensedParcels 
     * @returns void
     */
    private updateSensedParcels(sensedParcels: IOParcel[]): void {
        const now = Date.now();
        sensedParcels.forEach(parcel => {
            // Skip parcels this agent recently dropped — prevents re-grabbing a handover stack.
            const until = this.recentlyDropped.get(parcel.id);
            if (until !== undefined) {
                if (until > now) return;                        // still suppressed — do not re-add
                this.recentlyDropped.delete(parcel.id);        // cooldown expired — allow re-add
            }

            // Update the carriedBy field based on whether the parcel is currently believed to be carried by
            const carriedBy = parcel.carriedBy !== undefined
                ? (parcel.carriedBy || null)
                : (this.carriedByMe.has(parcel.id)
                    ? (this.parcels.getCurrentAll().find(p => p.id === parcel.id)?.carriedBy ?? null)
                    : null);
            
            // Update the parcel belief with the new information
            this.parcels.update(parcel.id, {
                id: parcel.id,
                lastPosition: { x: parcel.x, y: parcel.y },
                carriedBy,
                reward: parcel.reward,
            });

            // Reset the decay clock for this parcel since we have a new observation
            this.lastDecayApplied.delete(parcel.id);
        });
    }

    /**
     * Decay rewards for parcels not in the current sensing window.
     * Removes parcels whose reward has dropped to zero or below.
     * @param sensedParcels Array of currently sensed parcels to exclude from decay
     * @param decayInterval Time in milliseconds for each reward decay step
     * @param now Current timestamp to calculate decay
     * @returns void
     */
    private applyRewardDecay(sensedParcels: IOParcel[], decayInterval: number, now: number): void {
        // Create a set of currently sensed parcel IDs for quick lookup
        const sensedIds = new Set(sensedParcels.map(p => p.id));
        
        for (const parcel of this.parcels.getCurrentAll()) {
            // Skip parcels that are currently sensed
            if (sensedIds.has(parcel.id)) continue;
            
            // Use the independent decay clock; fall back to seenAt on the first decay pass
            const lastDecay = this.lastDecayApplied.get(parcel.id)
                ?? this.parcels.getLastTimestamp(parcel.id);
            if (lastDecay === undefined) continue;

            // Calculate how many decay intervals have passed since decay was last applied
            const ticks = Math.floor((now - lastDecay) / decayInterval);
            if (ticks <= 0) continue;

            // Apply decay to the parcel's reward based on the number of ticks
            const updatedReward = parcel.reward - ticks;
            if (updatedReward <= 0) {
                this.parcels.delete(parcel.id);
                this.lastDecayApplied.delete(parcel.id);
                continue;
            }
            // Update the reward without touching seenAt (preserves actual observation time)
            this.parcels.updateValuePreservingTimestamp(parcel.id, { ...parcel, reward: updatedReward });
            // Advance the decay clock by exactly the intervals processed
            this.lastDecayApplied.set(parcel.id, lastDecay + ticks * decayInterval);
        }
    }
        
    /**
     * Update parcel beliefs with the latest observed parcels.
     * @param parcels Array of parcels from the server, converted to internal Parcels type and stored in memory.
     * @returns void
     */
    updateParcels(sensedParcels: IOParcel[], sensedPositions: Position[]): void {
        this.updateSensedParcels(sensedParcels);

        // Invalidate lastPosition for parcels not currently visible but whose last known position is in view.
        // This must run every sensing cycle and must not be throttled by reward decay timing.
        this.parcels.invalidateAtSensedPositions(sensedParcels, sensedPositions);

        // Guard clause to prevent decaying rewards too frequently (only decay once per decay interval)
        const now = Date.now();
        const decayInterval = this.parcelSettings?.reward_decay_interval || 0;
        if (decayInterval <= 0) return;
        if (now - this.lastScoreUpdate < decayInterval) return; 
        
        // Update the last score update timestamp to the current time
        this.lastScoreUpdate = now; 
        
        // Update beliefs for parcels that are not currently sensed
        this.applyRewardDecay(sensedParcels, decayInterval, now);

    }

    getSettings(): ParcelSettings | null {
        return this.parcelSettings;
    }

    /**
     * Get the current believed positions of all parcels.
     * @returns An array of all parcels with their current believed state
     */
    getCurrentParcels(): Parcel[] {
        return this.parcels.getCurrentAll();
    }

    /** 
     * All parcels currently available for pickup (not carried by any agent).
     * @return An array of available parcels, filtered to exclude those currently carried by agents.
     */
    getAvailableParcels(): Parcel[] {
        return this.parcels.getCurrentAll().filter(p => p.carriedBy === null);
    }

    /**
     * Get the available parcel at the given position, if any.
     * @param pos The position to check.
     * @returns The parcel at the position, or undefined if none.
     */
    getParcelAt(pos: Position): Parcel | undefined {
        return this.getAvailableParcels().find(
            p => p.lastPosition?.x === pos.x && p.lastPosition?.y === pos.y
        );
    }

    /**
     * Get all parcels currently believed to be carried by a specific agent.
     * @param agentId
     * @returns An array of parcels currently believed to be carried by the specified agent.
     */
    getCarriedByAgent(agentId: string): Parcel[] {
        return this.parcels.getCurrentAll().filter(p => p.carriedBy === agentId);
    }

    /**
     * Mark parcels as picked up based on the server's acknowledgment of a pickup action.
     * @param parcel The parcel that was attempted to be picked up, used to update beliefs by marking it as carried by the agent and maintaining its last known position.
     * @returns 
     */
    markPickup(parcel: Parcel): void {
        if (!parcel.id) return;
        if (!parcel.lastPosition) return;

        if (parcel.carriedBy) this.carriedByMe.add(parcel.id);
        this.parcels.update(parcel.id, {
            ...parcel,
            carriedBy: parcel.carriedBy,
            lastPosition: { x: parcel.lastPosition.x, y: parcel.lastPosition.y },
        });
    }

    /**
     * Remove parcels from beliefs that are known to have been delivered based on a list of delivered parcel IDs.
     * @param deliveredParcels An array of parcels that have been delivered, used to clean up beliefs by removing them from memory. 
     * @returns void
     */
    cleanDeliveredParcels(deliveredParcels: Parcel[]): void {
        const expiry = Date.now() + config.parcels.droppedCooldownMs;
        for (const parcel of deliveredParcels) {
            this.parcels.delete(parcel.id);
            this.lastDecayApplied.delete(parcel.id);
            this.carriedByMe.delete(parcel.id);
            this.recentlyDropped.set(parcel.id, expiry);
        }
    }
}   
