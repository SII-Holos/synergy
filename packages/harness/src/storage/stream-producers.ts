import { RuntimeContext } from "../lifecycle/context"
import { MAX_PENDING, StorageQueue } from "./queue"
import { StorageBusyError, StorageClosedError, StorageConflictError } from "./errors"

export namespace ArtifactStreamProducers {
  const context = RuntimeContext.createAsyncContext<{ runtime: RuntimeContext.Instance; active: boolean }>()
  const state = RuntimeContext.state(() => ({
    closed: false,
    pending: 0,
    slots: Array.from({ length: 16 }, () => ({ queue: new StorageQueue("artifact.producer"), pending: 0 })),
    operations: new Set<Promise<unknown>>(),
  }))

  export function run<T>(body: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const runtime = RuntimeContext.current()
    const current = state()
    const parent = context.getStore()
    const nested = parent?.runtime === runtime && parent.active
    if (current.closed && !nested) return Promise.reject(new StorageClosedError())
    if (current.pending >= MAX_PENDING)
      return Promise.reject(new StorageBusyError("Authoritative artifact producer queue is full"))
    const slot = nested
      ? current.slots.find((slot) => slot.pending === 0)
      : current.slots.reduce((selected, slot) => (slot.pending < selected.pending ? slot : selected))
    if (!slot)
      return Promise.reject(new StorageBusyError("Artifact producer concurrency is occupied by its dependencies"))
    current.pending++
    slot.pending++
    const pending = slot.queue
      .run(
        async () => {
          if (RuntimeContext.current() !== runtime)
            throw new StorageConflictError("Artifact producer belongs to another Runtime")
          const scope = { runtime, active: true }
          try {
            return await context.run(scope, body)
          } finally {
            scope.active = false
          }
        },
        { signal },
      )
      .finally(() => {
        current.pending--
        slot.pending--
      })
    current.operations.add(pending)
    void pending.then(
      () => current.operations.delete(pending),
      () => current.operations.delete(pending),
    )
    return pending
  }

  export function closeAdmission() {
    state().closed = true
  }

  export async function drain() {
    const current = state()
    if (!current.closed) throw new StorageConflictError("Close artifact producer admission before draining it")
    while (current.operations.size) await Promise.allSettled([...current.operations])
  }
}
