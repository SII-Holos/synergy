import { PerformanceConfig } from "./config"
import { PerformanceSchema } from "./schema"
import { PerformanceStore } from "./store"

export namespace PerformanceTimeline {
  export function get(query: PerformanceSchema.TimelineQuery): PerformanceSchema.Timeline {
    const now = Date.now()
    const to = query.to ? Date.parse(query.to) : now
    const from = query.from ? Date.parse(query.from) : query.windowMs ? to - query.windowMs : to - 15 * 60 * 1000
    const config = PerformanceConfig.effective()
    const bucketMs = query.bucketMs ?? Math.max(1000, Math.ceil((to - from) / config.maxTimelineBuckets))
    const metrics = Array.isArray(query.metric) ? query.metric : query.metric ? [query.metric] : defaultMetrics
    const rows = PerformanceStore.queryMetrics({
      since: from,
      names: metrics,
      module: query.module,
      scopeID: query.scopeID,
      sessionID: query.sessionID,
      tool: query.tool,
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

  const defaultMetrics = [
    "http.request.duration",
    "process.memory.rss",
    "process.cpu.utilization",
    "process.event_loop.lag",
  ]
}
