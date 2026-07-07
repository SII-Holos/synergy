import { LatticeStore } from "./store"

/**
 * In-memory model-call accumulator. invoke increments per LLM call (hot path,
 * no storage write); the count is flushed to the Run at turn boundaries and
 * policy entry so `lattice.run.updated` is not published on every call.
 */
export namespace LatticeModelCalls {
  const pending = new Map<string, number>()

  export function record(sessionID: string): void {
    pending.set(sessionID, (pending.get(sessionID) ?? 0) + 1)
  }

  export function peek(sessionID: string): number {
    return pending.get(sessionID) ?? 0
  }

  /** Persist any accumulated calls into the run's modelCallCount. Returns the run's new total, or undefined if there is no run / nothing to flush. */
  export async function flush(scopeID: string, sessionID: string): Promise<number | undefined> {
    const delta = pending.get(sessionID) ?? 0
    if (delta === 0) {
      const run = await LatticeStore.getOrUndefined(scopeID, sessionID)
      return run?.modelCallCount
    }
    pending.delete(sessionID)
    const run = await LatticeStore.getOrUndefined(scopeID, sessionID)
    if (!run) return undefined
    const updated = await LatticeStore.update(scopeID, sessionID, (draft) => {
      draft.modelCallCount += delta
    })
    return updated.modelCallCount
  }

  export function clear(sessionID: string): void {
    pending.delete(sessionID)
  }
}
