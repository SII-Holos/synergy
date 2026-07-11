import { ObservabilityClock } from "./clock"
import { ObservabilityConfig } from "@/observability/config"
import { ObservabilityLiveEvents } from "./live-events"
import { ObservabilityContext } from "./context"
import { ObservabilityIssues } from "./issues"
import { ObservabilityMetrics } from "./metrics"
import { ObservabilityRedaction } from "./redaction"
import { ObservabilitySchema } from "./schema"
import { ObservabilityStore } from "./store"

export namespace ObservabilitySpans {
  export interface SpanContext {
    traceId: string
    correlationId?: string
    spanId: string
    parentSpanId?: string
    kind: ObservabilitySchema.SpanKind
    name: string
    module: ObservabilitySchema.Module
    source: ObservabilitySchema.Source
    startTime: number
    startMark: number
    lastActivityTime: number
    heartbeatTime?: number
    heartbeatCount: number
    stalled: boolean
    scopeID?: string
    sessionID?: string
    messageID?: string
    callID?: string
    rid?: string
    processId?: string
    pid?: number
    tool?: string
    attributes: Record<string, ObservabilitySchema.LabelValue>
  }

  export function start(input: {
    name: string
    module: ObservabilitySchema.Module
    kind?: ObservabilitySchema.SpanKind
    source?: ObservabilitySchema.Source
    traceId?: string
    correlationId?: string
    parentSpanId?: string
    scopeID?: string
    sessionID?: string
    messageID?: string
    callID?: string
    rid?: string
    processId?: string
    pid?: number
    tool?: string
    attributes?: Record<string, unknown>
  }): SpanContext | undefined {
    if (!ObservabilityConfig.current().enabled) return undefined
    const parent = ObservabilityContext.current()
    const time = ObservabilityClock.now()
    const redacted = ObservabilityRedaction.redactRecord(input.attributes)
    const context = ObservabilityContext.merge({
      correlationId: input.correlationId,
      traceId: input.traceId ?? parent.traceId ?? traceId(kindPrefix(input.kind ?? kindForName(input.name))),
      parentSpanId: input.parentSpanId ?? parent.spanId,
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
    const span: ObservabilitySchema.Span = ObservabilitySchema.Span.parse({
      traceId: context.traceId,
      correlationId: context.correlationId,
      spanId: ObservabilityClock.id("spn"),
      parentSpanId: context.parentSpanId,
      kind: input.kind ?? kindForName(input.name),
      name: input.name,
      module: input.module,
      source: context.source ?? "backend",
      startTime: time,
      lastActivityTime: time,
      heartbeatCount: 0,
      stalled: false,
      status: "running",
      scopeID: context.scopeID,
      sessionID: context.sessionID,
      messageID: context.messageID,
      callID: context.callID,
      rid: context.rid,
      processId: context.processId,
      pid: context.pid,
      tool: context.tool,
      attributes: redacted.value,
      redaction: redacted.summary,
    })
    ObservabilityStore.insertSpan(span)
    return {
      traceId: span.traceId,
      correlationId: span.correlationId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      kind: span.kind,
      name: span.name,
      module: span.module,
      source: span.source,
      startTime: time,
      startMark: ObservabilityClock.start(),
      lastActivityTime: time,
      heartbeatCount: 0,
      stalled: false,
      scopeID: span.scopeID,
      sessionID: span.sessionID,
      messageID: span.messageID,
      callID: span.callID,
      rid: span.rid,
      processId: span.processId,
      pid: span.pid,
      tool: span.tool,
      attributes: span.attributes,
    }
  }

  export function activity(ctx: SpanContext | undefined, attributes?: Record<string, unknown>) {
    if (!ctx) return
    const now = ObservabilityClock.now()
    const redacted = ObservabilityRedaction.redactRecord({ ...ctx.attributes, ...(attributes ?? {}) })
    ctx.lastActivityTime = now
    ctx.attributes = redacted.value
    ObservabilityStore.updateSpan(toSpan(ctx, { redaction: redacted.summary }))
  }

  export function heartbeat(ctx: SpanContext | undefined, attributes?: Record<string, unknown>) {
    if (!ctx) return
    const now = ObservabilityClock.now()
    ctx.heartbeatTime = now
    ctx.heartbeatCount++
    ctx.lastActivityTime = now
    const redacted = ObservabilityRedaction.redactRecord({ ...ctx.attributes, ...(attributes ?? {}) })
    ctx.attributes = redacted.value
    ObservabilityStore.updateSpan(
      toSpan(ctx, { heartbeatTime: now, heartbeatCount: ctx.heartbeatCount, redaction: redacted.summary }),
    )
  }

  export function markStalled(ctx: SpanContext | undefined, attributes?: Record<string, unknown>) {
    if (!ctx) return
    ctx.stalled = true
    ctx.lastActivityTime = ObservabilityClock.now()
    const redacted = ObservabilityRedaction.redactRecord({ ...ctx.attributes, ...(attributes ?? {}) })
    ctx.attributes = redacted.value
    ObservabilityStore.updateSpan(toSpan(ctx, { stalled: true, redaction: redacted.summary }))
  }

  export function end(
    ctx: SpanContext | undefined,
    opts: {
      status?: Exclude<ObservabilitySchema.SpanStatus, "running">
      error?: unknown
      attributes?: Record<string, unknown>
    } = {},
  ) {
    if (!ctx) return
    const durationMs = ObservabilityClock.durationMs(ctx.startMark)
    const time = ObservabilityClock.now()
    const status = opts.status ?? (opts.error ? "error" : "ok")
    const error = opts.error instanceof Error ? opts.error : undefined
    const redacted = ObservabilityRedaction.redactRecord({ ...ctx.attributes, ...(opts.attributes ?? {}) })
    const span = toSpan(ctx, {
      endTime: time,
      durationMs,
      status,
      errorCode: error?.name,
      errorMessage: error ? ObservabilityRedaction.error(error) : undefined,
      attributes: redacted.value,
      redaction: redacted.summary,
    })
    ObservabilityStore.updateSpan(span)
    ObservabilityMetrics.record({
      name: `${ctx.name}.duration`,
      value: durationMs,
      unit: "ms",
      module: ctx.module,
      source: ctx.source,
      correlationId: ctx.correlationId,
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      sessionID: ctx.sessionID,
      rid: ctx.rid,
      processId: ctx.processId,
      pid: ctx.pid,
      tool: ctx.tool,
      labels: { ...redacted.value, status },
    })
    ObservabilityLiveEvents.publish({ type: "trace.ended", trace: span })
    const config = ObservabilityConfig.current()
    const threshold =
      (config.thresholds as Record<string, number>)[`${ctx.module}.slowMs`] ?? config.slowTraceThresholdMs
    if (durationMs >= threshold) {
      ObservabilityIssues.raise({
        code: slowCode(ctx.module),
        severity: "warning",
        module: ctx.module,
        title: `Slow ${ctx.name}`,
        message: `${ctx.name} took ${Math.round(durationMs)}ms`,
        recommendation: "Open the trace detail to inspect the slowest child span and owning module.",
        correlationId: ctx.correlationId,
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        sessionID: ctx.sessionID,
        rid: ctx.rid,
        evidence: { observedValue: durationMs, unit: "ms" },
      })
    }
    return span
  }

  export async function measure<T>(
    input: Parameters<typeof start>[0],
    fn: (ctx: SpanContext) => Promise<T>,
  ): Promise<T> {
    const ctx = start(input)
    if (!ctx) return fn({} as SpanContext)
    try {
      return await ObservabilityContext.withContextAsync(
        { ...ctx, parentSpanId: ctx.parentSpanId, spanId: ctx.spanId },
        async () => {
          const result = await fn(ctx)
          end(ctx)
          return result
        },
      )
    } catch (error) {
      end(ctx, { status: "error", error })
      throw error
    }
  }

  export function traceId(prefix = "trc") {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
  }

  function toSpan(ctx: SpanContext, patch: Partial<ObservabilitySchema.Span> = {}): ObservabilitySchema.Span {
    return ObservabilitySchema.Span.parse({
      traceId: ctx.traceId,
      correlationId: ctx.correlationId,
      spanId: ctx.spanId,
      parentSpanId: ctx.parentSpanId,
      kind: ctx.kind,
      name: ctx.name,
      module: ctx.module,
      source: ctx.source,
      startTime: ctx.startTime,
      lastActivityTime: ctx.lastActivityTime,
      heartbeatTime: ctx.heartbeatTime,
      heartbeatCount: ctx.heartbeatCount,
      stalled: ctx.stalled,
      status: "running",
      scopeID: ctx.scopeID,
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID,
      rid: ctx.rid,
      processId: ctx.processId,
      pid: ctx.pid,
      tool: ctx.tool,
      attributes: ctx.attributes,
      ...patch,
    })
  }

  function kindForName(name: string): ObservabilitySchema.SpanKind {
    if (name.includes("http")) return "http"
    if (name.includes("session.step")) return "session_step"
    if (name.includes("session")) return "session"
    if (name.includes("tool")) return "tool"
    if (name.includes("llm")) return "llm"
    if (name.includes("storage")) return "storage"
    if (name.includes("library")) return "library"
    if (name.includes("frontend")) return "frontend"
    if (name.includes("sse")) return "sse"
    if (name.includes("process")) return "process"
    if (name.includes("mcp")) return "mcp"
    if (name.includes("plugin")) return "plugin"
    if (name.includes("channel")) return "channel"
    return "runtime"
  }

  function kindPrefix(kind: ObservabilitySchema.SpanKind) {
    if (kind === "session_step") return "step"
    return kind
  }

  function slowCode(module: ObservabilitySchema.Module) {
    if (module === "server") return "PERF_HTTP_SLOW_REQUEST"
    if (module === "session") return "PERF_SESSION_SLOW_TURN"
    if (module === "llm") return "PERF_LLM_SLOW_CALL"
    if (module === "tool") return "PERF_TOOL_STALLED"
    if (module === "storage") return "PERF_STORAGE_SLOW_OPERATION"
    if (module === "library") return "PERF_LIBRARY_SLOW_QUERY"
    if (module === "frontend") return "PERF_FRONTEND_LONG_TASK"
    return "PERF_TRACE_SLOW"
  }
}
