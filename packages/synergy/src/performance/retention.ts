import { PerformanceConfig } from "./config"
import { PerformanceStore } from "./store"

export namespace PerformanceRetention {
  export function run() {
    PerformanceStore.flush()
  }

  export function schedule() {
    PerformanceStore.open()
  }

  export function effectiveLimits() {
    const config = PerformanceConfig.current()
    return {
      metricRetentionMs: config.metricRetentionMs,
      traceRetentionMs: config.traceRetentionMs,
      maxSqliteBytes: config.storage.maxSqliteBytes,
      walCheckpointIntervalMs: config.storage.walCheckpointIntervalMs,
    }
  }
}
