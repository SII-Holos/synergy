import { ObservabilityIssues } from "../observability/issues"
import { ObservabilityMetrics } from "../observability/metrics"
import { NotFoundError } from "./errors"
import { excludingQueueWait } from "./queue"

const STORAGE_DURATION_SAMPLE_RATE = 0.02

/**
 * The single measurement source for authoritative-store work.
 *
 * Every operation the store performs is attributed here, whether it starts on
 * the public `Storage` surface or in a store primitive that queries the driver
 * directly, so latency, volume and errors share one convention and no operation
 * is invisible to telemetry.
 *
 * Duration excludes the admission wait reported separately by
 * `storage.queue.wait`. That wait is measured where it happens, and counting it
 * here as well described the same interval twice: the largest
 * `storage.operation.duration` tails were queue wait on the serialized reader
 * rather than work.
 */
export async function measureStorageOperation<T>(
  operation: string,
  keyPrefix: string,
  body: () => Promise<T>,
  options: { silentNotFound?: boolean } = {},
): Promise<T> {
  return excludingQueueWait(async (queueWaitMs) => {
    const start = performance.now()
    let status = "ok"
    try {
      return await body()
    } catch (error) {
      status = "error"
      // Expected "file does not exist" paths (note scope probing, index
      // rebuilds) used try/catch as control flow; every miss raised a
      // PERF_STORAGE_OPERATION_ERROR issue and amplified telemetry writes.
      // Keep the error metric (observability still counts it) but skip the
      // issue when the caller declared the miss expected.
      const isNotFound = error instanceof NotFoundError
      if (!(options.silentNotFound && isNotFound)) {
        ObservabilityIssues.raise({
          code: "PERF_STORAGE_OPERATION_ERROR",
          severity: "warning",
          module: "storage",
          title: "Storage operation failed",
          message: `${operation} failed for ${keyPrefix}`,
          evidence: {
            operation,
            keyPrefix,
            errorName: error instanceof Error ? error.name : "unknown",
          },
        })
      }
      throw error
    } finally {
      const durationMs = Math.max(0, performance.now() - start - queueWaitMs())
      ObservabilityMetrics.record({
        name: "storage.operation.duration",
        value: durationMs,
        unit: "ms",
        module: "storage",
        labels: { operation, keyPrefix, status },
        sampleRate: status === "error" ? 1 : STORAGE_DURATION_SAMPLE_RATE,
      })
      ObservabilityMetrics.record({
        name: "storage.operation.count",
        value: 1,
        unit: "count",
        module: "storage",
        labels: { operation, status },
      })
      if (status === "error") {
        ObservabilityMetrics.record({
          name: "storage.operation.error",
          value: 1,
          unit: "count",
          module: "storage",
          labels: { operation },
        })
      }
    }
  })
}
