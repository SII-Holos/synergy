import { ObservabilityClock } from "./clock"
import { ObservabilityConfig } from "@/observability/config"
import { ObservabilityContext } from "./context"
import { ObservabilityRedaction } from "./redaction"
import { ObservabilitySchema } from "./schema"
import { ObservabilityStore } from "./store"

export namespace ObservabilityMetrics {
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
    const context = ObservabilityContext.merge({
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
      module: input.module,
      source: input.source ?? "backend",
    })
    const redacted = ObservabilityRedaction.redactRecord(input.labels)
    const time = ObservabilityClock.now()
    const metric = ObservabilitySchema.Metric.parse({
      metricId: ObservabilityClock.id("met"),
      time,
      iso: ObservabilityClock.iso(time),
      name: input.name,
      value: input.value,
      unit: input.unit,
      source: context.source ?? "backend",
      module: input.module,
      labels: redacted.value,
      correlationId: context.correlationId,
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      scopeID: context.scopeID,
      sessionID: context.sessionID,
      messageID: context.messageID,
      callID: context.callID,
      rid: context.rid,
      processId: context.processId,
      pid: context.pid,
      tool: context.tool,
      sampleRate,
      redaction: redacted.summary,
    })
    ObservabilityStore.insertMetric(metric)
  }

  export function percentile(values: number[], p: number) {
    if (values.length === 0) return undefined
    const sorted = [...values].sort((a, b) => a - b)
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
    return sorted[index]
  }
}
