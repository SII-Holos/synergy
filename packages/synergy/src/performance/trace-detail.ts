import { Observability } from "../observability"
import { PerformanceError } from "./error"
import { PerformanceSchema } from "./schema"
import { PerformanceStore } from "./store"

export namespace PerformanceTraceDetail {
  export function list(query: PerformanceSchema.TraceListQuery): PerformanceSchema.TraceList {
    const since = query.from ? Date.parse(query.from) : Date.now() - 15 * 60 * 1000
    const until = query.to ? Date.parse(query.to) : undefined
    const rows = PerformanceStore.querySpans({
      since: Number.isFinite(since) ? since : undefined,
      until: until !== undefined && Number.isFinite(until) ? until : undefined,
      limit: query.limit ?? 50,
      minDurationMs: query.minDurationMs,
      status: query.status,
      scopeID: query.scopeID,
      sessionID: query.sessionID,
    }).filter((row) => !query.kind || kind(row.name) === query.kind)
    return PerformanceSchema.TraceList.parse({
      generatedAt: new Date().toISOString(),
      items: rows.map((row) => ({
        traceId: row.trace_id,
        kind: kind(row.name),
        name: row.name,
        status: row.status,
        startedAt: new Date(row.start_time).toISOString(),
        endedAt: row.end_time ? new Date(row.end_time).toISOString() : undefined,
        durationMs: row.duration_ms ?? undefined,
        module: row.module,
        source: row.source,
        sessionID: row.session_id ?? undefined,
        rid: row.rid ?? undefined,
        tool: row.tool ?? undefined,
        errorCode: row.error_code ?? undefined,
        redactionApplied: true,
      })),
    })
  }

  export async function detail(
    traceId: string,
    opts: { maxEvents?: number; includeEvents?: boolean; includeAttributes?: boolean } = {},
  ): Promise<PerformanceSchema.TraceDetail> {
    const spans = PerformanceStore.querySpans({ traceId, limit: 10_000 }).sort((a, b) => a.start_time - b.start_time)
    const events =
      opts.includeEvents === false
        ? []
        : (await Observability.query({ traceId, limit: opts.maxEvents ?? 500 })).map(projectEvent)
    if (!spans.length && !events.length) {
      throw new PerformanceError("PERF_TRACE_NOT_FOUND", "Performance trace was not found.", 404, { traceId })
    }
    const parsed = spans.map((row) =>
      PerformanceSchema.Span.parse({
        traceId: row.trace_id,
        spanId: row.span_id,
        parentSpanId: row.parent_span_id ?? undefined,
        name: row.name,
        module: row.module,
        source: row.source,
        startTime: row.start_time,
        endTime: row.end_time ?? undefined,
        durationMs: row.duration_ms ?? undefined,
        status: row.status,
        errorCode: row.error_code ?? undefined,
        errorMessage: row.error_message ?? undefined,
        sessionID: row.session_id ?? undefined,
        rid: row.rid ?? undefined,
        tool: row.tool ?? undefined,
        attributes: opts.includeAttributes === false ? {} : parseJson(row.attributes_json),
      }),
    )
    return PerformanceSchema.TraceDetail.parse({
      generatedAt: new Date().toISOString(),
      traceId,
      root: parsed.find((span) => !span.parentSpanId) ?? parsed[0],
      spans: parsed,
      events,
      redaction: { applied: true, omittedAttributes: opts.includeAttributes === false ? parsed.length : 0 },
    })
  }

  function kind(name: string) {
    if (name.includes("http")) return "request"
    if (name.includes("session")) return "session"
    if (name.includes("tool")) return "tool"
    if (name.includes("llm")) return "provider"
    if (name.includes("storage")) return "storage"
    if (name.includes("frontend")) return "frontend"
    return "runtime"
  }

  function projectEvent(event: Observability.Event): PerformanceSchema.TraceEvent {
    return PerformanceSchema.TraceEvent.parse({
      time: event.time,
      iso: event.iso,
      type: event.type,
      level: event.level,
      traceId: event.traceId,
      sessionID: event.sessionID,
      messageID: event.messageID,
      callID: event.callID,
      rid: event.rid,
      tool: event.tool,
      processId: event.processId,
      pid: event.pid,
      dataKeys: event.data && typeof event.data === "object" ? Object.keys(event.data).slice(0, 24) : [],
      redactionApplied: true,
    })
  }

  function parseJson(text: string) {
    try {
      return JSON.parse(text) as Record<string, string | number | boolean | null>
    } catch {
      return {}
    }
  }
}
