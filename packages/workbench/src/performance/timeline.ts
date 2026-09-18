import { ObservabilityStore } from "@ericsanchezok/synergy-harness/observability/store"
import { PerformanceCatalog } from "./catalog"
import { ObservabilityConfig } from "@ericsanchezok/synergy-harness/observability/config"
import { PerformanceError } from "./error"
import { PerformanceSchema } from "./schema"

export namespace PerformanceTimeline {
  export function get(query: PerformanceSchema.TimelineQuery): PerformanceSchema.Timeline {
    const now = Date.now()
    const to = parseTime(query.to, now)
    const from = parseTime(query.from, query.windowMs ? to - query.windowMs : to - 15 * 60 * 1000)
    if (from >= to) throw new PerformanceError("PERF_INVALID_QUERY", "Timeline from must be before to.", 400)

    const config = ObservabilityConfig.current()
    const bucketMs = query.bucketMs ?? Math.max(1000, Math.floor((to - from) / config.maxTimelineBuckets) + 1)
    const bucketCount = Math.floor((to - from) / bucketMs) + 1
    if (bucketCount > config.maxTimelineBuckets) {
      throw new PerformanceError("PERF_TOO_MANY_BUCKETS", "Timeline query exceeds the configured bucket limit.", 400, {
        maxBuckets: config.maxTimelineBuckets,
        bucketCount,
      })
    }

    const metrics = normalizeMetrics(query.metric)
    const buckets = bucketStarts(from, to, bucketMs)
    const series = metrics.map((name) => {
      const info = PerformanceCatalog.get(name)
      if (!info) throw new PerformanceError("PERF_INVALID_QUERY", "Timeline metric is not allowed.", 400)
      const stat = query.stat ?? info.defaultStat
      const rows = ObservabilityStore.queryMetricBuckets({
        since: from,
        until: to,
        names: [name],
        module: query.module,
        scopeID: query.scopeID,
        sessionID: query.sessionID,
        tool: query.tool,
        providerID: query.providerID,
        bucketMs,
      })
      const bucketed = new Map(rows.map((row) => [row.bucket, row]))
      const points = buckets.map((time, index) => {
        const bucket = bucketed.get(index)
        return {
          time,
          value: bucket ? (stat === "rate" ? bucket.sum / Math.max(1, bucketMs / 1000) : bucket[stat]) : null,
          sampleCount: bucket?.count ?? 0,
        }
      })
      const sampleCount = points.reduce((total, point) => total + (point.sampleCount ?? 0), 0)
      return PerformanceSchema.TimelineSeries.parse({
        name,
        label: info.label,
        unit: info.unit,
        kind: info.kind,
        stat,
        sampleCount,
        module: info.module,
        source: info.source,
        points,
      })
    })
    return PerformanceSchema.Timeline.parse({
      generatedAt: new Date().toISOString(),
      from,
      to,
      bucketMs,
      series,
    })
  }

  function parseTime(value: string | undefined, fallback: number) {
    if (!value) return fallback
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed)) throw new PerformanceError("PERF_INVALID_QUERY", "Invalid timeline time range.", 400)
    return parsed
  }

  function normalizeMetrics(metric: string | string[] | undefined) {
    const requested = Array.isArray(metric) ? metric : metric ? [metric] : PerformanceCatalog.defaultMetricNames
    const resolved = requested.map((name) => PerformanceCatalog.resolveName(name))
    const unique = [...new Set(resolved)]
    const invalid = unique.filter((name) => !PerformanceCatalog.get(name))
    if (invalid.length)
      throw new PerformanceError("PERF_INVALID_QUERY", "Timeline metric is not allowed.", 400, {
        invalidMetrics: invalid,
      })
    return unique
  }

  function bucketStarts(from: number, to: number, bucketMs: number) {
    const buckets: number[] = []
    for (let bucket = from; bucket <= to; bucket += bucketMs) buckets.push(bucket)
    return buckets
  }

  export const allowedMetricNames = PerformanceCatalog.allMetricNames()
}
