import type { ContinuationKernel } from "../session/continuation-kernel"

/**
 * LatticeContinuationPolicy: drives an active Lattice run forward when its
 * session goes idle — starting the next BlueprintLoop when a step's Blueprint is
 * ready, or delivering a continuation prompt to keep planning/analysis moving.
 *
 * Fully implemented in the Lattice state-machine step; registered with the
 * ContinuationKernel at lower priority than the BlueprintLoop policy so a live
 * loop owns the idle while it is running.
 */
export const LatticeContinuationPolicy: ContinuationKernel.Policy = {
  id: "lattice",
  priority: 50,
  async handle(_gate) {
    return false
  },
}
