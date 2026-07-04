import { PerformanceCatalog } from "./catalog"
import { PerformanceConfig } from "./config"
import { PerformanceError } from "./error"
import { PerformanceMetrics } from "./metrics"
import { PerformanceSchema } from "./schema"
import { PerformanceStore } from "./store"

export namespace PerformanceTimeline {
  const ROW_LIMIT = 50_000

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
    const storageNames = [...new Set(metrics.flatMap((name) => PerformanceCatalog.storageNamesFor(name)))]
    const rows = PerformanceStore.queryMetrics({
      since: from,
      until: to,
      names: storageNames,
      module: query.module,
      scopeID: query.scopeID,
      sessionID: query.sessionID,
      tool: query.tool,
      providerID: query.providerID,
      limit: ROW_LIMIT + 1,
      newestFirst: true,
    })
    const truncated = rows.length > ROW_LIMIT
    const usableRows = truncated ? rows.slice(-ROW_LIMIT) : rows
    const buckets = bucketStarts(from, to, bucketMs)
    const bucketed = bucketRows(usableRows, metrics, from, bucketMs, buckets.length)

    const series = metrics.map((name) => {
      const info = PerformanceCatalog.get(name)
      if (!info) throw new PerformanceError("PERF_INVALID_QUERY", "Timeline metric is not allowed.", 400)
      const stat = query.stat ?? info.defaultStat
      const bucketsForMetric = bucketed.get(name) ?? new Map<number, Bucket>()
      const points = buckets.map((time, index) => {
        const bucket = bucketsForMetric.get(index)
        return {
          time,
          value: bucket ? aggregate(bucket, stat, bucketMs) : null,
          sampleCount: bucket?.values.length ?? 0,
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
        quality: truncated ? { truncated: true, partial: true } : undefined,
        points,
      })
    })
    return PerformanceSchema.Timeline.parse({
      generatedAt: new Date().toISOString(),
      from,
      to,
      bucketMs,
      quality: truncated ? { truncated: true, partial: true } : undefined,
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
    if (invalid.length) {
      throw new PerformanceError("PERF_INVALID_QUERY", "Timeline metric is not allowed.", 400, {
        invalidMetrics: invalid,
      })
    }
    return unique
  }

  function bucketStarts(from: number, to: number, bucketMs: number) {
    const buckets: number[] = []
    for (let bucket = from; bucket <= to; bucket += bucketMs) buckets.push(bucket)
    return buckets
  }

  interface Bucket {
    values: number[]
    latestTime: number
    latestValue: number
  }

  function bucketRows(
    rows: PerformanceStore.StoredMetric[],
    metrics: string[],
    from: number,
    bucketMs: number,
    bucketCount: number,
  ) {
    const requested = new Set(metrics)
    const bucketed = new Map<string, Map<number, Bucket>>()
    for (const row of rows) {
      const name = PerformanceCatalog.resolveName(row.name)
      if (!requested.has(name)) continue
      const bucketIndex = Math.floor((row.time - from) / bucketMs)
      if (bucketIndex < 0 || bucketIndex >= bucketCount) continue
      let metricBuckets = bucketed.get(name)
      if (!metricBuckets) {
        metricBuckets = new Map()
        bucketed.set(name, metricBuckets)
      }
      let bucket = metricBuckets.get(bucketIndex)
      if (!bucket) {
        bucket = { values: [], latestTime: row.time, latestValue: row.value }
        metricBuckets.set(bucketIndex, bucket)
      }
      bucket.values.push(row.value)
      if (row.time >= bucket.latestTime) {
        bucket.latestTime = row.time
        bucket.latestValue = row.value
      }
    }
    return bucketed
  }

  function aggregate(bucket: Bucket, stat: PerformanceCatalog.Stat, bucketMs: number) {
    if (stat === "latest") return bucket.latestValue
    if (stat === "sum") return bucket.values.reduce((sum, value) => sum + value, 0)
    if (stat === "rate") return bucket.values.reduce((sum, value) => sum + value, 0) / Math.max(1, bucketMs / 1000)
    if (stat === "max") return Math.max(...bucket.values)
    if (stat === "p50") return PerformanceMetrics.percentile(bucket.values, 50) ?? null
    if (stat === "p95") return PerformanceMetrics.percentile(bucket.values, 95) ?? null
    if (stat === "p99") return PerformanceMetrics.percentile(bucket.values, 99) ?? null
    return bucket.values.reduce((sum, value) => sum + value, 0) / bucket.values.length
  }

  export const allowedMetricNames = PerformanceCatalog.allMetricNames()
}
