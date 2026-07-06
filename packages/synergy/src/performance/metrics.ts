import { PerformanceClock } from "./clock"
import { PerformanceConfig } from "./config"
import { PerformanceRedaction } from "./redact"
import { PerformanceSchema } from "./schema"
import { PerformanceStore } from "./store"

export namespace PerformanceMetrics {
  export function record(input: {
    name: string
    value: number
    unit: PerformanceSchema.Unit
    module: PerformanceSchema.Module
    source?: PerformanceSchema.Source
    labels?: Record<string, unknown>
    traceId?: string
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
    const config = PerformanceConfig.current()
    if (!config.enabled) return
    const sampleRate = input.sampleRate ?? config.samplingRate
    if (sampleRate < 1 && Math.random() > sampleRate) return
    const time = PerformanceClock.now()
    // Hot path: `record` is only ever called from internal, TypeScript-typed
    // call sites, and labels are already sanitized/coerced by
    // PerformanceRedaction.record. Constructing the Metric directly avoids a
    // per-record Zod parse on the highest-frequency observability path (issue
    // #350 H5). Validation still runs at the external ingestion boundary
    // (browser batches) where input is untrusted.
    const metric: PerformanceSchema.Metric = {
      metricId: PerformanceClock.id("met"),
      time,
      iso: PerformanceClock.iso(time),
      name: input.name,
      value: input.value,
      unit: input.unit,
      source: input.source ?? "backend",
      module: input.module,
      labels: PerformanceRedaction.record(input.labels),
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
      sampleRate,
    }
    PerformanceStore.insertMetric(metric)
  }

  export function percentile(values: number[], p: number) {
    if (values.length === 0) return undefined
    const sorted = [...values].sort((a, b) => a - b)
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
    return sorted[index]
  }
}
