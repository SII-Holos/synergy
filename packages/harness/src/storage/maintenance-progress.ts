import { observeStorageProgress } from "./progress"
import { AsyncLocalStorage } from "node:async_hooks"
import type { StorageStartupProgress } from "@ericsanchezok/synergy-util/runtime-startup"

const context = new AsyncLocalStorage<{ operation: number; report?: (progress: StorageStartupProgress) => void }>()

export namespace MaintenanceProgress {
  export function run<T>(report: ((progress: StorageStartupProgress) => void) | undefined, body: () => Promise<T>) {
    return observeStorageProgress<T, StorageStartupProgress>(
      (record) => context.run({ operation: 0, report: record }, body),
      report,
    )
  }

  export function announce(timeoutMs: number) {
    const state = context.getStore()
    if (!state) return
    state.report?.({ stage: "maintenance", operation: ++state.operation, current: 0, total: 0, bytes: 0, timeoutMs })
  }
}
