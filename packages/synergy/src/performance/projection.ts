import { ObservabilityIssues } from "@/observability/issues"
import type { ObservabilitySchema } from "@/observability/schema"
import type { ObservabilityStore } from "@/observability/store"
import { PerformanceSchema } from "./schema"
import { parseJson } from "@/util/json-parse"

export namespace PerformanceProjection {
  export function issue(issue: ObservabilitySchema.Issue): PerformanceSchema.Issue {
    return PerformanceSchema.Issue.parse({
      issueId: issue.issueId,
      time: issue.time,
      iso: issue.iso,
      severity: issue.severity,
      status: issue.status,
      code: issue.code,
      title: issue.title,
      message: issue.message,
      recommendation: issue.recommendation,
      module: issue.module,
      correlationId: issue.correlationId,
      scopeID: issue.scopeID,
      traceId: issue.traceId,
      spanId: issue.spanId,
      sessionID: issue.sessionID,
      messageID: issue.messageID,
      callID: issue.callID,
      rid: issue.rid,
      evidence: issue.evidence,
      firstSeenTime: issue.firstSeenTime,
      lastSeenTime: issue.lastSeenTime,
      occurrenceCount: issue.occurrenceCount,
      fingerprint: issue.fingerprint,
    })
  }

  export function issueRow(row: ObservabilityStore.StoredIssue): PerformanceSchema.Issue {
    return issue(ObservabilityIssues.fromRow(row))
  }

  export function traceListItem(span: ObservabilitySchema.Span): PerformanceSchema.TraceListItem {
    return PerformanceSchema.TraceListItem.parse({
      traceId: span.traceId,
      correlationId: span.correlationId,
      kind: traceKind(span.kind),
      name: span.name,
      status: span.status,
      startedAt: new Date(span.startTime).toISOString(),
      endedAt: span.endTime ? new Date(span.endTime).toISOString() : undefined,
      durationMs: span.durationMs,
      module: span.module,
      source: span.source,
      sessionID: span.sessionID,
      scopeID: span.scopeID,
      rid: span.rid,
      tool: span.tool,
      errorCode: span.errorCode,
      redactionApplied: span.redaction.applied,
    })
  }

  export function traceRow(row: ObservabilityStore.StoredSpan): PerformanceSchema.TraceListItem {
    return PerformanceSchema.TraceListItem.parse({
      traceId: row.trace_id,
      correlationId: row.correlation_id ?? undefined,
      kind: traceKind(row.kind),
      name: row.name,
      status: row.status,
      startedAt: new Date(row.start_time).toISOString(),
      endedAt: row.end_time ? new Date(row.end_time).toISOString() : undefined,
      durationMs: row.duration_ms ?? undefined,
      module: row.module,
      source: row.source,
      sessionID: row.session_id ?? undefined,
      scopeID: row.scope_id ?? undefined,
      rid: row.rid ?? undefined,
      tool: row.tool ?? undefined,
      errorCode: row.error_code ?? undefined,
      redactionApplied: row.redaction_json
        ? parseJson<{ applied?: boolean }>(row.redaction_json).applied !== false
        : true,
    })
  }

  export function traceKind(
    spanKind: ObservabilityStore.StoredSpan["kind"] | ObservabilitySchema.SpanKind,
  ): NonNullable<PerformanceSchema.TraceListQuery["kind"]> {
    switch (spanKind) {
      case "http":
        return "request"
      case "session":
      case "session_step":
        return "session"
      case "llm":
        return "provider"
      case "tool":
        return "tool"
      case "storage":
        return "storage"
      case "frontend":
        return "frontend"
      case "mcp":
        return "mcp"
      case "plugin":
        return "plugin"
      case "channel":
        return "channel"
      case "permission":
      case "library":
      case "sse":
      case "process":
      case "diagnostic":
      case "runtime":
        return "runtime"
    }
  }

  export function spanKinds(
    kind: NonNullable<PerformanceSchema.TraceListQuery["kind"]>,
  ): ObservabilitySchema.SpanKind[] {
    switch (kind) {
      case "request":
        return ["http"]
      case "session":
        return ["session", "session_step"]
      case "tool":
        return ["tool"]
      case "provider":
        return ["llm"]
      case "storage":
        return ["storage"]
      case "frontend":
        return ["frontend"]
      case "mcp":
        return ["mcp"]
      case "plugin":
        return ["plugin"]
      case "channel":
        return ["channel"]
      case "runtime":
        return ["permission", "library", "sse", "process", "diagnostic", "runtime"]
    }
  }
}
