import { ObservabilityStore } from "@/observability/store"
import { PerformanceSchema } from "./schema"
import { parseJson } from "@/util/json-parse"

export namespace PerformanceInflight {
  export function get(
    input: { scopeID?: string; sessionID?: string; staleMs?: number; limit?: number } = {},
  ): PerformanceSchema.Inflight {
    const spans = ObservabilityStore.queryInflight(input).map((row) =>
      PerformanceSchema.InflightSpan.parse({
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
        scopeID: row.scope_id ?? undefined,
        sessionID: row.session_id ?? undefined,
        messageID: row.message_id ?? undefined,
        callID: row.call_id ?? undefined,
        rid: row.rid ?? undefined,
        processId: row.process_id ?? undefined,
        pid: row.pid ?? undefined,
        tool: row.tool ?? undefined,
        attributes: parseJson(row.attributes_json),
        ageMs: row.age_ms,
        idleMs: row.idle_ms,
        stale: row.stale,
      }),
    )
    return PerformanceSchema.Inflight.parse({ generatedAt: new Date().toISOString(), spans })
  }
}
