import { ObservabilityClock } from "./clock"
import { ObservabilityConfig } from "@/observability/config"
import { ObservabilityContext } from "./context"
import { ObservabilityRedaction } from "./redaction"
import { ObservabilitySchema } from "./schema"
import { ObservabilityStore } from "./store"

export namespace ObservabilityMetrics {
  const AGGREGATE_FLUSH_MS = 1000
  const AGGREGATED_COUNT_METRICS = new Set([
    "llm.stream.output_chars",
    "process.output.chars",
    "storage.operation.count",
  ])
  const aggregates = new Map<string, AggregatedMetric>()
  let aggregateTimer: ReturnType<typeof setTimeout> | undefined

  type MetricInput = Parameters<typeof record>[0]
  type ResolvedMetricInput = Omit<MetricInput, "sampleRate"> & {
    sampleRate: number
    source: ObservabilitySchema.Source
  }

  interface AggregatedMetric {
    input: Omit<ResolvedMetricInput, "value">
    value: number
  }

  ObservabilityStore.beforeFlush(flushAggregates)

  export function record(input: {
    name: string
    value: number
    unit: ObservabilitySchema.Unit
    module: ObservabilitySchema.Module
    source?: ObservabilitySchema.Source
    labels?: Record<string, unknown>
    traceId?: string
    correlationId?: string
    spanId?: string
    parentSpanId?: string
    scopeID?: string
    sessionID?: string
    messageID?: string
    callID?: string
    rid?: string
    processId?: string
    pid?: number
    tool?: string
    sampleRate?: number
  }) {
    const config = ObservabilityConfig.current()
    if (!config.enabled) return
    const sampleRate = input.sampleRate ?? config.samplingRate
    if (sampleRate < 1 && Math.random() > sampleRate) return
    const context = ObservabilityContext.current()
    const resolved: ResolvedMetricInput = {
      ...input,
      source: input.source ?? context.source ?? "backend",
      correlationId: input.correlationId ?? context.correlationId,
      traceId: input.traceId ?? context.traceId,
      spanId: input.spanId ?? context.spanId,
      parentSpanId: input.parentSpanId ?? context.spanId ?? context.parentSpanId,
      scopeID: input.scopeID ?? context.scopeID,
      sessionID: input.sessionID ?? context.sessionID,
      messageID: input.messageID ?? context.messageID,
      callID: input.callID ?? context.callID,
      rid: input.rid ?? context.rid,
      processId: input.processId ?? context.processId,
      pid: input.pid ?? context.pid,
      tool: input.tool ?? context.tool,
      sampleRate,
    }
    if (shouldAggregate(resolved)) {
      aggregate(resolved)
      return
    }
    insert(resolved)
  }

  function insert(input: ResolvedMetricInput) {
    const redacted = ObservabilityRedaction.redactRecord(input.labels)
    const time = ObservabilityClock.now()
    const metric: ObservabilitySchema.Metric = {
      metricId: ObservabilityClock.id("met"),
      time,
      iso: ObservabilityClock.iso(time),
      name: input.name,
      value: input.value,
      unit: input.unit,
      source: input.source,
      module: input.module,
      labels: redacted.value,
      correlationId: input.correlationId,
      traceId: input.traceId,
      spanId: input.spanId,
      parentSpanId: input.parentSpanId,
      scopeID: input.scopeID,
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      rid: input.rid,
      processId: input.processId,
      pid: input.pid,
      tool: input.tool,
      sampleRate: input.sampleRate,
      redaction: redacted.summary,
    }
    ObservabilityStore.insertMetric(metric)
  }

  function shouldAggregate(input: ResolvedMetricInput) {
    return input.unit === "count" && AGGREGATED_COUNT_METRICS.has(input.name)
  }

  function aggregate(input: ResolvedMetricInput) {
    const key = aggregateKey(input)
    const existing = aggregates.get(key)
    if (existing) {
      existing.value += input.value
    } else {
      const { value: _value, ...rest } = input
      aggregates.set(key, { input: rest, value: input.value })
    }
    if (!aggregateTimer) {
      aggregateTimer = setTimeout(flushAggregates, AGGREGATE_FLUSH_MS)
      aggregateTimer.unref()
    }
  }

  export function flushAggregates() {
    if (aggregateTimer) clearTimeout(aggregateTimer)
    aggregateTimer = undefined
    if (aggregates.size === 0) return
    const items = [...aggregates.values()]
    aggregates.clear()
    for (const item of items) insert({ ...item.input, value: item.value })
  }

  function aggregateKey(input: ResolvedMetricInput) {
    return [
      input.name,
      input.unit,
      input.module,
      input.source,
      input.correlationId,
      input.traceId,
      input.spanId,
      input.parentSpanId,
      input.scopeID,
      input.sessionID,
      input.messageID,
      input.callID,
      input.rid,
      input.processId,
      input.pid,
      input.tool,
      input.sampleRate,
      input.labels ? JSON.stringify(input.labels) : "",
    ].join(" ")
  }

  export function percentile(values: number[], p: number) {
    if (values.length === 0) return undefined
    const sorted = [...values].sort((a, b) => a - b)
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
    return sorted[index]
  }
}
