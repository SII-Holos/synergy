import { PerformanceStore } from "./store"

export namespace PerformanceMigration {
  export const schemaVersion = "1"
  export const requiredMetaKeys = ["schemaVersion", "createdAt", "lastRetentionRunAt", "lastWalCheckpointAt"] as const

  export function initialize() {
    PerformanceStore.open()
    return PerformanceStore.meta()
  }
}
