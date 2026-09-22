import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { LatticeStore } from "./store"
import { LatticeTypes } from "./types"

/**
 * In-memory model-call accumulator. invoke increments per LLM call (hot path,
 * no storage write); the count is flushed to the Run at turn boundaries and
 * policy entry so `lattice.run.updated` is not published on every call.
 */
export namespace LatticeModelCalls {
  const runtimeState = RuntimeContext.state(() => ({
    pending: new Map<string, number>(),
  }))

  export function record(sessionID: string): void {
    const instanceState = runtimeState()

    instanceState.pending.set(sessionID, (instanceState.pending.get(sessionID) ?? 0) + 1)
  }

  export function peek(sessionID: string): number {
    const instanceState = runtimeState()

    return instanceState.pending.get(sessionID) ?? 0
  }

  /** Persist any accumulated calls into the run's modelCallCount. Returns the run's new total, or undefined if there is no run / nothing to flush. */
  export async function flush(scopeID: string, sessionID: string): Promise<number | undefined> {
    const instanceState = runtimeState()

    const delta = instanceState.pending.get(sessionID) ?? 0
    if (delta === 0) {
      const run = await LatticeStore.getOrUndefined(scopeID, sessionID)
      return run?.modelCallCount
    }
    instanceState.pending.delete(sessionID)
    const run = await LatticeStore.getOrUndefined(scopeID, sessionID)
    if (!run) return undefined
    if (LatticeTypes.isTerminalRun(run.status)) return run.modelCallCount
    const updated = await LatticeStore.update(scopeID, sessionID, (draft) => {
      draft.modelCallCount += delta
    })
    return updated.modelCallCount
  }

  export function clear(sessionID: string): void {
    const instanceState = runtimeState()

    instanceState.pending.delete(sessionID)
  }
}
