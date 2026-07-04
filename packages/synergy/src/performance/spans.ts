import { Observability } from "../observability"
import { PerformanceClock } from "./clock"
import { PerformanceEvents } from "./events"
import { PerformanceConfig } from "./config"
import { PerformanceIssues } from "./issues"
import { PerformanceMetrics } from "./metrics"
import { PerformanceRedaction } from "./redact"
import { PerformanceSchema } from "./schema"
import { PerformanceStore } from "./store"

export namespace PerformanceSpans {
  export interface SpanContext {
    traceId: string
    spanId: string
    name: string
    module: PerformanceSchema.Module
    source: PerformanceSchema.Source
    startTime: number
    startMark: number
    parentSpanId?: string
    scopeID?: string
    sessionID?: string
    messageID?: string
    callID?: string
    rid?: string
    processId?: string
    pid?: number
    tool?: string
  }

  export function start(input: {
    name: string
    module: PerformanceSchema.Module
    source?: PerformanceSchema.Source
    traceId?: string
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
  }): SpanContext {
    const time = PerformanceClock.now()
    const span: PerformanceSchema.Span = {
      traceId: input.traceId ?? Observability.traceId("perf"),
      spanId: PerformanceClock.id("spn"),
      parentSpanId: input.parentSpanId,
      name: input.name,
      module: input.module,
      source: input.source ?? "backend",
      startTime: time,
      status: "ok",
      scopeID: input.scopeID,
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      rid: input.rid,
      processId: input.processId,
      pid: input.pid,
      tool: input.tool,
      attributes: PerformanceRedaction.record(input.attributes),
    }
    return {
      ...input,
      traceId: span.traceId,
      spanId: span.spanId,
      source: span.source,
      startTime: time,
      startMark: PerformanceClock.start(),
    }
  }

  export function end(
    ctx: SpanContext,
    opts: { status?: PerformanceSchema.SpanStatus; error?: unknown; attributes?: Record<string, unknown> } = {},
  ) {
    const durationMs = PerformanceClock.durationMs(ctx.startMark)
    const time = PerformanceClock.now()
    const status = opts.status ?? (opts.error ? "error" : "ok")
    const error = opts.error instanceof Error ? opts.error : undefined
    const span: PerformanceSchema.Span = {
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      parentSpanId: ctx.parentSpanId,
      name: ctx.name,
      module: ctx.module,
      source: ctx.source,
      startTime: ctx.startTime,
      endTime: time,
      durationMs,
      status,
      errorCode: error?.name,
      errorMessage: error ? PerformanceRedaction.error(error) : undefined,
      scopeID: ctx.scopeID,
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID,
      rid: ctx.rid,
      processId: ctx.processId,
      pid: ctx.pid,
      tool: ctx.tool,
      attributes: PerformanceRedaction.record(opts.attributes),
    }
    PerformanceStore.insertSpan(span)
    PerformanceMetrics.record({
      name: `${ctx.name}.duration`,
      value: durationMs,
      unit: "ms",
      module: ctx.module,
      source: ctx.source,
      traceId: ctx.traceId,
      spanId: ctx.spanId,
      sessionID: ctx.sessionID,
      rid: ctx.rid,
      processId: ctx.processId,
      pid: ctx.pid,
      tool: ctx.tool,
      labels: { status },
    })
    PerformanceEvents.publish({
      type: "performance.trace.ended",
      trace: {
        traceId: span.traceId,
        kind: traceKind(span.name),
        name: span.name,
        status: span.status,
        startedAt: new Date(span.startTime).toISOString(),
        endedAt: span.endTime ? new Date(span.endTime).toISOString() : undefined,
        durationMs: span.durationMs,
        module: span.module,
        source: span.source,
        sessionID: span.sessionID,
        rid: span.rid,
        tool: span.tool,
        errorCode: span.errorCode,
        redactionApplied: true,
      },
    })
    const config = PerformanceConfig.current()
    const threshold =
      (config.thresholds as Record<string, number>)[`${ctx.module}.slowMs`] ?? config.slowTraceThresholdMs
    if (durationMs >= threshold) {
      PerformanceIssues.raise({
        code: slowCode(ctx.module),
        severity: "warning",
        module: ctx.module,
        title: `Slow ${ctx.name}`,
        message: `${ctx.name} took ${Math.round(durationMs)}ms`,
        recommendation: "Open the trace detail to inspect the slowest child span and owning module.",
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
    try {
      const result = await fn(ctx)
      end(ctx)
      return result
    } catch (error) {
      end(ctx, { status: "error", error })
      throw error
    }
  }

  function traceKind(name: string) {
    if (name.includes("http")) return "request"
    if (name.includes("session")) return "session"
    if (name.includes("tool")) return "tool"
    if (name.includes("llm")) return "provider"
    if (name.includes("storage")) return "storage"
    if (name.includes("frontend")) return "frontend"
    return "runtime"
  }

  function slowCode(module: PerformanceSchema.Module) {
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
