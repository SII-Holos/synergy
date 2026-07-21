import { Observability } from "@/observability"
import { ObservabilityStore } from "@/observability/store"
import { PerformanceError } from "./error"
import { PerformanceProjection } from "./projection"
import { PerformanceSchema } from "./schema"
import { parseJson } from "@/util/json-parse"

export namespace PerformanceTraceDetail {
  export function list(query: PerformanceSchema.TraceListQuery): PerformanceSchema.TraceList {
    const since = query.from ? Date.parse(query.from) : Date.now() - 15 * 60 * 1000
    const until = query.to ? Date.parse(query.to) : undefined
    const baseLimit = query.limit ?? 50
    const rows = ObservabilityStore.querySpans({
      since: Number.isFinite(since) ? since : undefined,
      until: until !== undefined && Number.isFinite(until) ? until : undefined,
      limit: baseLimit,
      minDurationMs: query.minDurationMs,
      status: query.status,
      scopeID: query.scopeID,
      sessionID: query.sessionID,
      kinds: query.kind ? PerformanceProjection.spanKinds(query.kind) : undefined,
      distinctTrace: true,
    })
    return PerformanceSchema.TraceList.parse({
      generatedAt: new Date().toISOString(),
      items: rows.map(PerformanceProjection.traceRow),
    })
  }

  export async function detail(
    traceId: string,
    opts: { maxEvents?: number; includeEvents?: boolean; includeAttributes?: boolean } = {},
  ): Promise<PerformanceSchema.TraceDetail> {
    const spans = ObservabilityStore.querySpans({ traceId, limit: 10_000 }).sort((a, b) => a.start_time - b.start_time)
    const events =
      opts.includeEvents === false
        ? []
        : (await Observability.query({ traceId, limit: opts.maxEvents ?? 500 })).map(projectEvent)
    if (!spans.length && !events.length)
      throw new PerformanceError("PERF_TRACE_NOT_FOUND", "Performance trace was not found.", 404, { traceId })
    const parsed = spans.map((row) =>
      PerformanceSchema.Span.parse({
        traceId: row.trace_id,
        correlationId: row.correlation_id ?? undefined,
        spanId: row.span_id,
        parentSpanId: row.parent_span_id ?? undefined,
        kind: row.kind,
        name: row.name,
        module: row.module,
        source: row.source,
        startTime: row.start_time,
        endTime: row.end_time ?? undefined,
        durationMs: row.duration_ms ?? undefined,
        status: row.status,
        lastActivityTime: row.last_activity_time ?? undefined,
        heartbeatTime: row.heartbeat_time ?? undefined,
        heartbeatCount: row.heartbeat_count ?? undefined,
        stalled: row.stalled ? true : undefined,
        errorCode: row.error_code ?? undefined,
        errorMessage: row.error_message ?? undefined,
        sessionID: row.session_id ?? undefined,
        scopeID: row.scope_id ?? undefined,
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

  function projectEvent(event: Observability.Event): PerformanceSchema.TraceEvent {
    return PerformanceSchema.TraceEvent.parse({
      time: event.time,
      iso: event.iso,
      type: event.type,
      level: event.level,
      traceId: event.traceId,
      correlationId: event.correlationId,
      sessionID: event.sessionID,
      messageID: event.messageID,
      callID: event.callID,
      rid: event.rid,
      tool: event.tool,
      processId: event.processId,
      pid: event.pid,
      dataKeys: event.data && typeof event.data === "object" ? Object.keys(event.data).slice(0, 24) : [],
      redactionApplied: event.redaction.applied,
    })
  }
}
