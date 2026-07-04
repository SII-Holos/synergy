import { PerformanceConfig } from "./config"
import { PerformanceError } from "./error"
import { PerformanceSchema } from "./schema"
import { PerformanceStore } from "./store"

export namespace PerformanceTimeline {
  export function get(query: PerformanceSchema.TimelineQuery): PerformanceSchema.Timeline {
    const now = Date.now()
    const to = parseTime(query.to, now)
    const from = parseTime(query.from, query.windowMs ? to - query.windowMs : to - 15 * 60 * 1000)
    if (from >= to) throw new PerformanceError("PERF_INVALID_QUERY", "Timeline from must be before to.", 400)

    const config = PerformanceConfig.effective()
    const bucketMs = query.bucketMs ?? Math.max(1000, Math.ceil((to - from) / config.maxTimelineBuckets))
    const bucketCount = Math.floor((to - from) / bucketMs) + 1
    if (bucketCount > config.maxTimelineBuckets) {
      throw new PerformanceError("PERF_TOO_MANY_BUCKETS", "Timeline query exceeds the configured bucket limit.", 400, {
        maxBuckets: config.maxTimelineBuckets,
        bucketCount,
      })
    }

    const metrics = normalizeMetrics(query.metric)
    const rows = PerformanceStore.queryMetrics({
      since: from,
      names: metrics,
      module: query.module,
      scopeID: query.scopeID,
      sessionID: query.sessionID,
      tool: query.tool,
      providerID: query.providerID,
      limit: 50_000,
    })
    const series = metrics.map((name) => {
      const matching = rows.filter((row) => row.name === name)
      const points: Array<{ time: number; value: number | null }> = []
      for (let bucket = from; bucket <= to; bucket += bucketMs) {
        const values = matching
          .filter((row) => row.time >= bucket && row.time < bucket + bucketMs)
          .map((row) => row.value)
        points.push({
          time: bucket,
          value: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
        })
      }
      return PerformanceSchema.TimelineSeries.parse({
        name,
        unit: matching[0]?.unit ?? "count",
        module: matching[0]?.module,
        source: matching[0]?.source,
        points,
      })
    })
    return PerformanceSchema.Timeline.parse({ generatedAt: new Date().toISOString(), from, to, bucketMs, series })
  }

  function parseTime(value: string | undefined, fallback: number) {
    if (!value) return fallback
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) throw new PerformanceError("PERF_INVALID_QUERY", "Invalid timeline time range.", 400)
    return parsed
  }

  function normalizeMetrics(metric: string | string[] | undefined) {
    const metrics = Array.isArray(metric) ? metric : metric ? [metric] : defaultMetrics
    const unique = [...new Set(metrics)]
    const invalid = unique.filter((name) => !allowedMetrics.has(name))
    if (invalid.length) {
      throw new PerformanceError("PERF_INVALID_QUERY", "Timeline metric is not allowed.", 400, {
        invalidMetrics: invalid,
      })
    }
    return unique
  }

  export const allowedMetricNames = [
    "http.request.duration",
    "http.request.size",
    "http.response.size",
    "session.turn.duration",
    "session.turn.active",
    "session.turn.error",
    "session.turn.retry",
    "session.tool.count",
    "session.llm.count",
    "llm.call.duration",
    "llm.stream.start_ms",
    "llm.first_token.ms",
    "llm.output.chars",
    "llm.tokens.input",
    "llm.tokens.output",
    "tool.execution.duration",
    "tool.execution.count",
    "tool.execution.error",
    "tool.execution.stalled",
    "tool.phase.duration",
    "storage.operation.duration",
    "storage.operation.count",
    "storage.operation.error",
    "storage.read.bytes",
    "storage.write.bytes",
    "library.operation.duration",
    "library.operation.error",
    "frontend.web_vital",
    "frontend.resource.duration",
    "frontend.long_task.duration",
    "frontend.collector.rejected",
    "process.memory.rss",
    "process.memory.heap_used",
    "process.cpu.utilization",
    "process.event_loop.lag",
    "process.active.count",
    "pty.session.duration",
    "pty.connection.open",
    "pty.connection.duration",
    "pty.write.failure",
    "server.sse.connection.open",
    "server.sse.connection.duration",
    "server.sse.heartbeat",
    "server.sse.write_dropped",
    "server.sse.write_failure",
    "observability.writer.dropped",
    "observability.writer.queue_depth",
    "observability.writer.flush.duration",
    "observability.writer.append_failure",
  ]

  const allowedMetrics = new Set<string>(allowedMetricNames)

  const defaultMetrics = [
    "http.request.duration",
    "process.memory.rss",
    "process.cpu.utilization",
    "process.event_loop.lag",
  ]
}
