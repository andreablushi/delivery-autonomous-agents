import type { Crate } from "../../../../models/crate.js";
import type { IOCrate } from "../../../../models/djs.js";
import type { Position } from "../../../../models/position.js";
import { Tracker } from "./utils/tracker.js";

/**
 * Beliefs about dynamic crate positions in the environment.
 * Tracks where crates currently are so A* and PDDL planning can treat them as obstacles.
 */
export class CrateBeliefs {
    private crates = new Tracker<Crate>();

    /**
     * Update crate beliefs with the latest observed crates.
     * @param sensedCrates Array of crates from the server.
     * @param sensedPositions Array of positions currently in sensing range.
     */
    updateCrates(sensedCrates: IOCrate[], sensedPositions: Position[]): void {
        sensedCrates.forEach(crate => {
            this.crates.update(crate.id, { id: crate.id, lastPosition: { x: crate.x, y: crate.y } });
        });
        this.crates.invalidateAtSensedPositions(sensedCrates, sensedPositions);
    }

    /**
     * Get the current believed positions of all crates.
     * @returns An array of all crates with their current believed state.
     */
    getCurrentCrates(): Crate[] {
        return this.crates.getCurrentAll();
    }

    /**
     * Check if any known crate is currently believed to be at the given position.
     * @param pos The position to check for crate presence.
     * @returns True if a crate is believed to be at the position, false otherwise.
     */
    isCrateAt(pos: Position): boolean {
        return this.crates.getCurrentAll().some(
            c => c.lastPosition?.x === pos.x && c.lastPosition?.y === pos.y
        );
    }
}
