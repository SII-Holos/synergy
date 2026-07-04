import fs from "fs/promises"
import { PerformanceIssues } from "./issues"
import { PerformanceMetrics } from "./metrics"

export namespace PerformanceWriter {
  interface Entry {
    file: string
    line: string
  }

  const MAX_QUEUE = 5000
  const FLUSH_INTERVAL_MS = 250
  const FLUSH_BATCH = 500
  let queue: Entry[] = []
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let flushing: Promise<void> | undefined
  let dropped = 0
  let lastDepthMetricAt = 0

  export function append(file: string, line: string) {
    if (queue.length >= MAX_QUEUE) {
      dropped++
      queue.shift()
      PerformanceMetrics.record({
        name: "observability.writer.dropped",
        value: 1,
        unit: "count",
        module: "observability",
        labels: { reason: "queue_full", dropped },
      })
      PerformanceIssues.raise({
        code: "PERF_OBSERVABILITY_WRITER_BACKPRESSURE",
        severity: "warning",
        module: "observability",
        title: "Observability writer queue is dropping entries",
        message: "Observability writer queue is full and oldest entries are being dropped",
        evidence: { queueDepth: queue.length, dropped },
      })
    }
    queue.push({ file, line })
    const now = Date.now()
    if (now - lastDepthMetricAt >= 1000) {
      lastDepthMetricAt = now
      PerformanceMetrics.record({
        name: "observability.writer.queue_depth",
        value: queue.length,
        unit: "count",
        module: "observability",
      })
    }
    scheduleFlush()
  }

  export async function flush() {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = undefined
    if (flushing) return flushing
    flushing = flushAll().finally(() => {
      flushing = undefined
      if (queue.length > 0) scheduleFlush()
    })
    return flushing
  }

  async function flushAll() {
    while (queue.length > 0) {
      const start = performance.now()
      const batch = queue.splice(0, FLUSH_BATCH)
      const grouped = new Map<string, string[]>()
      for (const entry of batch) {
        const lines = grouped.get(entry.file) ?? []
        lines.push(entry.line)
        grouped.set(entry.file, lines)
      }
      for (const [file, lines] of grouped) {
        await fs.mkdir(file.replace(/[\\/][^\\/]+$/, ""), { recursive: true }).catch(() => {})
        await fs.appendFile(file, lines.join(""), "utf8").catch(() => {
          dropped += lines.length
          PerformanceMetrics.record({
            name: "observability.writer.dropped",
            value: lines.length,
            unit: "count",
            module: "observability",
            labels: { reason: "append_failed" },
          })
          PerformanceIssues.raise({
            code: "PERF_OBSERVABILITY_WRITER_APPEND_FAILED",
            severity: "error",
            module: "observability",
            title: "Observability writer append failed",
            message: "Observability writer could not append queued entries",
            evidence: { dropped: lines.length },
          })
        })
      }
      PerformanceMetrics.record({
        name: "observability.writer.flush.duration",
        value: performance.now() - start,
        unit: "ms",
        module: "observability",
        labels: { batchSize: batch.length, remaining: queue.length },
      })
    }
  }

  export function stats() {
    return { queueDepth: queue.length, dropped }
  }

  function scheduleFlush() {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      void flush()
    }, FLUSH_INTERVAL_MS)
    flushTimer.unref?.()
  }
}

process.once("beforeExit", () => {
  void PerformanceWriter.flush()
})
