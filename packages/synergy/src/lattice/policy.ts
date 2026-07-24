import type { ContinuationKernel } from "../session/continuation-kernel"
import { LatticeController } from "./controller"
import { LatticeStore } from "./store"

export const LatticeContinuationPolicy: ContinuationKernel.Policy = {
  id: "lattice",
  priority: 50,
  async handle(gate) {
    if (gate.session.workflow?.kind !== "lattice") return undefined
    const run = await LatticeStore.getOrUndefined(gate.scopeID, gate.sessionID)
    if (!run || run.id !== gate.session.workflow.runID) return undefined
    return LatticeController.reconcileGate(gate)
  },
}
