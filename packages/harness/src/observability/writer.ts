import { RuntimeContext } from "../lifecycle/context"
import fs from "fs/promises"
import { ObservabilityConfig } from "./config"
import { ObservabilityIssues } from "./issues"
import { ObservabilityMetrics } from "./metrics"

export namespace ObservabilityWriter {
  interface Entry {
    file: string
    line: string
  }

  const MAX_QUEUE = 5000
  const FLUSH_INTERVAL_MS = 250
  const FLUSH_BATCH = 500
  const runtimeState = RuntimeContext.state(() => ({
    stopped: false,
    queue: [] as Entry[],
    flushTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    flushing: undefined as Promise<void> | undefined,
    dropped: 0,
    lastDepthMetricAt: 0,
  }))

  export function append(file: string, line: string) {
    const instanceState = runtimeState()

    if (instanceState.stopped || !ObservabilityConfig.current().storage.jsonlMirrorEnabled) return
    if (instanceState.queue.length >= MAX_QUEUE) {
      instanceState.dropped++
      instanceState.queue.shift()
      ObservabilityMetrics.record({
        name: "observability.writer.dropped",
        value: 1,
        unit: "count",
        module: "observability",
        labels: { reason: "queue_full", dropped: instanceState.dropped },
      })
      ObservabilityIssues.raise({
        code: "PERF_OBSERVABILITY_WRITER_BACKPRESSURE",
        severity: "warning",
        module: "observability",
        title: "Observability writer queue is dropping entries",
        message: "Observability writer queue is full and oldest mirror entries are being dropped",
        evidence: { queueDepth: instanceState.queue.length, dropped: instanceState.dropped },
      })
    }
    instanceState.queue.push({ file, line })
    const now = Date.now()
    if (now - instanceState.lastDepthMetricAt >= 1000) {
      instanceState.lastDepthMetricAt = now
      ObservabilityMetrics.record({
        name: "observability.writer.queue_depth",
        value: instanceState.queue.length,
        unit: "count",
        module: "observability",
      })
    }
    scheduleFlush()
  }

  export async function stop() {
    runtimeState().stopped = true
    await flush()
  }

  export async function flush() {
    const instanceState = runtimeState()

    if (instanceState.flushTimer) clearTimeout(instanceState.flushTimer)
    instanceState.flushTimer = undefined
    if (instanceState.flushing) return instanceState.flushing
    instanceState.flushing = flushAll().finally(() => {
      instanceState.flushing = undefined
      if (instanceState.queue.length > 0) scheduleFlush()
    })
    return instanceState.flushing
  }

  export function stats() {
    const instanceState = runtimeState()

    return { queueDepth: instanceState.queue.length, dropped: instanceState.dropped }
  }

  async function flushAll() {
    const instanceState = runtimeState()

    while (instanceState.queue.length > 0) {
      const start = performance.now()
      const batch = instanceState.queue.splice(0, FLUSH_BATCH)
      const grouped = new Map<string, string[]>()
      for (const entry of batch) {
        const lines = grouped.get(entry.file) ?? []
        lines.push(entry.line)
        grouped.set(entry.file, lines)
      }
      for (const [file, lines] of grouped) {
        await fs.mkdir(file.replace(/[\\/][^\\/]+$/, ""), { recursive: true }).catch(() => {})
        await fs.appendFile(file, lines.join(""), "utf8").catch(() => {
          instanceState.dropped += lines.length
          ObservabilityMetrics.record({
            name: "observability.writer.dropped",
            value: lines.length,
            unit: "count",
            module: "observability",
            labels: { reason: "append_failed" },
          })
          ObservabilityIssues.raise({
            code: "PERF_OBSERVABILITY_WRITER_APPEND_FAILED",
            severity: "error",
            module: "observability",
            title: "Observability writer append failed",
            message: "Observability writer could not append queued mirror entries",
            evidence: { dropped: lines.length },
          })
        })
      }
      ObservabilityMetrics.record({
        name: "observability.writer.flush.duration",
        value: performance.now() - start,
        unit: "ms",
        module: "observability",
        labels: { batchSize: batch.length, remaining: instanceState.queue.length },
      })
    }
  }

  function scheduleFlush() {
    const instanceState = runtimeState()

    if (instanceState.flushTimer) return
    instanceState.flushTimer = setTimeout(() => {
      instanceState.flushTimer = undefined
      void flush()
    }, FLUSH_INTERVAL_MS)
    instanceState.flushTimer.unref?.()
  }
}
