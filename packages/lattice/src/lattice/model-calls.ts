import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { LatticeStore } from "./store"

/**
 * In-memory model-call accumulator. invoke increments per LLM call (hot path,
 * no storage write); the count is flushed to the Run at turn boundaries and
 * policy entry so `lattice.run.updated` is not published on every call.
 */
export namespace LatticeModelCalls {
  const runtimeState = RuntimeContext.state(() => ({
    pending: new Map<string, number>(),
    flushing: new Map<string, { id: string; scopeID: string; runID: string; delta: number }>(),
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
    if (Storage.inTransaction()) throw new Error("Native model counter flushing owns its commit boundary")
    using lock = await Lock.write(`lattice-model-calls:${sessionID}`)
    const instanceState = runtimeState()
    const delta = instanceState.pending.get(sessionID) ?? 0
    if (delta === 0) return (await LatticeStore.getOrUndefined(scopeID, sessionID))?.modelCallCount
    let batch = instanceState.flushing.get(sessionID)
    if (!batch) {
      const run = await LatticeStore.getOrUndefined(scopeID, sessionID)
      if (!run) return
      batch = { id: `lattice-model-calls:${sessionID}:${crypto.randomUUID()}`, scopeID, runID: run.id, delta }
      instanceState.flushing.set(sessionID, batch)
    }
    if (batch.scopeID !== scopeID) throw new Error("Native model counter Scope changed before acknowledgement")
    const selected = batch
    const total = await Storage.transaction(
      async () => {
        const updated = await LatticeStore.updateByRunID(scopeID, selected.runID, (draft) => {
          draft.modelCallCount += selected.delta
        })
        return updated.modelCallCount
      },
      {
        operationID: selected.id,
        requestHash: JSON.stringify({ scopeID, sessionID, runID: selected.runID, delta: selected.delta }),
      },
    )
    const remaining = (instanceState.pending.get(sessionID) ?? 0) - selected.delta
    if (remaining < 0) throw new Error("Native model counter evidence changed before acknowledgement")
    if (remaining) instanceState.pending.set(sessionID, remaining)
    else instanceState.pending.delete(sessionID)
    instanceState.flushing.delete(sessionID)
    return total
  }

  export function clear(sessionID: string): void {
    const instanceState = runtimeState()

    instanceState.pending.delete(sessionID)
    instanceState.flushing.delete(sessionID)
  }
}
