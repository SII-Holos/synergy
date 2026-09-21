import { AsyncLocalStorage } from "node:async_hooks"
import { Context } from "../util/context"
import type {
  StorageMaintenanceEvent,
  StorageMaintenanceOperation,
  StorageMaintenanceStage,
} from "@ericsanchezok/synergy-util/runtime-startup"

type Observation = { sequence: number; record(event: StorageMaintenanceEvent): void }
const observation = Context.create<Observation>("storage-maintenance")

export function beginStorageMaintenance(operation: StorageMaintenanceOperation, timeoutMs: number) {
  const current = observation.tryUse()
  if (!current) return
  const id = ++current.sequence
  const startedAt = performance.now()
  let finished = false
  current.record({ phase: "maintenance", id, state: "started", operation, timeoutMs })
  return {
    stage(stage: StorageMaintenanceStage) {
      if (!finished) current.record({ phase: "maintenance", id, state: "stage", stage })
    },
    finish(state: "completed" | "failed") {
      if (finished) return
      finished = true
      current.record({
        phase: "maintenance",
        id,
        state,
        elapsedMs: Math.max(0, Math.floor(performance.now() - startedAt)),
      })
    },
  }
}

export async function observeStorageMaintenance<T>(
  operation: () => Promise<T>,
  report: (event: StorageMaintenanceEvent) => void,
): Promise<T> {
  const notify = AsyncLocalStorage.bind(report)
  const events: StorageMaintenanceEvent[] = []
  let wake = Promise.withResolvers<void>()
  let complete = false
  let closed = false
  let overflow: Error | undefined
  const pending = observation
    .provide(
      {
        sequence: 0,
        record(event) {
          if (closed) return
          // Lifecycle transitions cannot be coalesced like counts; overflow fails observation instead of silently losing transitions.
          if (events.length >= 1024) {
            overflow = new Error("Storage maintenance observation queue exceeded its limit")
            closed = true
            wake.resolve()
            return
          }
          events.push(event)
          wake.resolve()
        },
      },
      async () => operation(),
    )
    .finally(() => {
      complete = true
      wake.resolve()
    })
  pending.catch(() => {})
  try {
    for (;;) {
      await wake.promise
      if (overflow) throw overflow
      for (const event of events.splice(0)) notify(event)
      if (complete) return await pending
      wake = Promise.withResolvers<void>()
    }
  } finally {
    closed = true
    await pending.catch(() => {})
  }
}
