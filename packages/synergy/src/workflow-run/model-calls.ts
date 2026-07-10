import { WorkflowRunStore } from "./store"

/**
 * In-memory model-call accumulator keyed by runID (boss + every seat +
 * contractor session contributes). invoke increments per LLM call; the count is
 * flushed to the Run at policy entry so `workflow.run.updated` is not published
 * on every call.
 */
export namespace WorkflowModelCalls {
  const pending = new Map<string, number>()

  export function record(runID: string): void {
    pending.set(runID, (pending.get(runID) ?? 0) + 1)
  }

  export function peek(runID: string): number {
    return pending.get(runID) ?? 0
  }

  export async function flush(scopeID: string, runID: string): Promise<number | undefined> {
    const delta = pending.get(runID) ?? 0
    if (delta === 0) {
      const run = await WorkflowRunStore.getOrUndefined(scopeID, runID)
      return run?.budget.used
    }
    pending.delete(runID)
    const run = await WorkflowRunStore.getOrUndefined(scopeID, runID)
    if (!run) return undefined
    const updated = await WorkflowRunStore.update(scopeID, runID, (draft) => {
      draft.budget.used += delta
    })
    return updated.budget.used
  }

  export function clear(runID: string): void {
    pending.delete(runID)
  }
}
