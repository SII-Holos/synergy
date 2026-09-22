import { Context } from "../util/context"
import { RuntimeContext } from "../lifecycle/context"
import { ObservabilityClock } from "./clock"
import { ObservabilityConfig } from "./config"
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
  const runtimeState = RuntimeContext.state(() => ({
    stopped: false,
    aggregates: new Map<string, AggregatedMetric>(),
    aggregateTimer: undefined as ReturnType<typeof setTimeout> | undefined,
  }))

  const forwarding = Context.create<(input: MetricInput) => void>("metric-forwarder")

  export function withForwarder<T>(forward: (input: MetricInput) => void, run: () => T): T {
    return forwarding.provide(forward, run)
  }

  type MetricInput = Parameters<typeof record>[0]
  type ResolvedMetricInput = Omit<MetricInput, "sampleRate"> & {
    sampleRate: number
    source: ObservabilitySchema.Source
  }

  interface AggregatedMetric {
    input: Omit<ResolvedMetricInput, "value">
    value: number
  }

  export function register() {
    ObservabilityStore.beforeFlush(flushAggregates)
  }

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
    if (!RuntimeContext.tryCurrent() || runtimeState().stopped) return
    const forwarder = forwarding.tryUse()
    if (forwarder) {
      forwarder(input)
      return
    }
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
    }
    ObservabilityStore.insertMetric(metric)
  }

  function shouldAggregate(input: ResolvedMetricInput) {
    return input.unit === "count" && AGGREGATED_COUNT_METRICS.has(input.name)
  }

  function aggregate(input: ResolvedMetricInput) {
    const instanceState = runtimeState()

    const key = aggregateKey(input)
    const existing = instanceState.aggregates.get(key)
    if (existing) {
      existing.value += input.value
    } else {
      const { value: _value, ...rest } = input
      instanceState.aggregates.set(key, { input: rest, value: input.value })
    }
    if (!instanceState.aggregateTimer) {
      instanceState.aggregateTimer = setTimeout(flushAggregates, AGGREGATE_FLUSH_MS)
      instanceState.aggregateTimer.unref()
    }
  }

  export function stop() {
    runtimeState().stopped = true
    flushAggregates()
  }

  export function flushAggregates() {
    const instanceState = runtimeState()

    if (instanceState.aggregateTimer) clearTimeout(instanceState.aggregateTimer)
    instanceState.aggregateTimer = undefined
    if (instanceState.aggregates.size === 0) return
    const items = [...instanceState.aggregates.values()]
    instanceState.aggregates.clear()
    for (const item of items) insert({ ...item.input, value: item.value })
  }

  // Aggregated counters measure volume, not identity. Per-turn and per-request
  // identity (session, message, call, correlation, request, process, and
  // span/trace ids) shards this family into one row per concurrent turn, which
  // is what defeated the row reduction; those fields still ride along on the
  // aggregate row. Scope and tool stay because queries filter and rank by them.
  function aggregateKey(input: ResolvedMetricInput) {
    return [
      input.name,
      input.unit,
      input.module,
      input.source,
      input.scopeID,
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
