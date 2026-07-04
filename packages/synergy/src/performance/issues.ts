import { PerformanceClock } from "./clock"
import { PerformanceEvents } from "./events"
import { PerformanceRedaction } from "./redact"
import { PerformanceSchema } from "./schema"
import { PerformanceStore } from "./store"

export namespace PerformanceIssues {
  const publishedFingerprints = new Map<string, number>()
  const PUBLISH_COALESCE_MS = 60_000

  export function raise(input: {
    code: string
    severity: PerformanceSchema.IssueSeverity
    module: PerformanceSchema.Module
    title: string
    message: string
    recommendation?: string
    traceId?: string
    spanId?: string
    sessionID?: string
    messageID?: string
    callID?: string
    rid?: string
    evidence?: Record<string, unknown>
  }) {
    const time = PerformanceClock.now()
    const fingerprint = [input.code, input.module, input.traceId ?? input.sessionID ?? input.rid ?? "global"].join(":")
    const issue = PerformanceSchema.Issue.parse({
      issueId: PerformanceClock.id("iss"),
      time,
      iso: PerformanceClock.iso(time),
      severity: input.severity,
      status: "open",
      code: input.code,
      title: PerformanceRedaction.text(input.title),
      message: PerformanceRedaction.text(input.message),
      recommendation: input.recommendation ? PerformanceRedaction.text(input.recommendation) : undefined,
      module: input.module,
      traceId: input.traceId,
      spanId: input.spanId,
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      rid: input.rid,
      evidence: PerformanceRedaction.record(input.evidence),
      firstSeenTime: time,
      lastSeenTime: time,
      occurrenceCount: 1,
      fingerprint,
    })
    PerformanceStore.insertIssue(issue)
    const lastPublishedAt = publishedFingerprints.get(fingerprint) ?? 0
    if (time - lastPublishedAt >= PUBLISH_COALESCE_MS) {
      publishedFingerprints.set(fingerprint, time)
      PerformanceEvents.publish({ type: "performance.issue.raised", issue })
    }
    return issue
  }

  export function list(
    input: { status?: string; severity?: string; module?: string; scopeID?: string; limit?: number } = {},
  ) {
    return PerformanceStore.queryIssues({
      status: input.status ?? "open",
      severity: input.severity,
      module: input.module,
      scopeID: input.scopeID,
      limit: input.limit,
    }).map((row) =>
      PerformanceSchema.Issue.parse({
        issueId: row.issue_id,
        time: row.time,
        iso: row.iso,
        severity: row.severity,
        status: row.status,
        code: row.code,
        title: row.title,
        message: row.message,
        recommendation: row.recommendation ?? undefined,
        module: row.module,
        traceId: row.trace_id ?? undefined,
        spanId: row.span_id ?? undefined,
        sessionID: row.session_id ?? undefined,
        messageID: row.message_id ?? undefined,
        callID: row.call_id ?? undefined,
        rid: row.rid ?? undefined,
        evidence: parseJson(row.evidence_json),
        firstSeenTime: row.first_seen_time,
        lastSeenTime: row.last_seen_time,
        occurrenceCount: row.occurrence_count,
        fingerprint: row.fingerprint,
      }),
    )
  }

  function parseJson(text: string) {
    try {
      return JSON.parse(text) as Record<string, string | number | boolean | null>
    } catch {
      return {}
    }
  }
}
