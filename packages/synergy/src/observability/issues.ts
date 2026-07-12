import { ObservabilityClock } from "./clock"
import { ObservabilityLiveEvents } from "./live-events"
import { ObservabilityContext } from "./context"
import { ObservabilityRedaction } from "./redaction"
import { ObservabilitySchema } from "./schema"
import { parseJson } from "@/util/json-parse"
import { ObservabilityStore } from "./store"

export namespace ObservabilityIssues {
  const publishedFingerprints = new Map<string, number>()
  const PUBLISH_COALESCE_MS = 60_000
  const MAX_PUBLISHED_FINGERPRINTS = 1_000

  export function raise(input: {
    code: string
    severity: ObservabilitySchema.IssueSeverity
    module: ObservabilitySchema.Module
    title: string
    message: string
    recommendation?: string
    correlationId?: string
    traceId?: string
    spanId?: string
    scopeID?: string
    sessionID?: string
    messageID?: string
    callID?: string
    rid?: string
    evidence?: Record<string, unknown>
    fingerprint?: string
  }) {
    const context = ObservabilityContext.merge({
      correlationId: input.correlationId,
      traceId: input.traceId,
      spanId: input.spanId,
      scopeID: input.scopeID,
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      rid: input.rid,
      module: input.module,
      source: "backend",
    })
    const time = ObservabilityClock.now()
    const evidence = ObservabilityRedaction.redactRecord({
      ...input.evidence,
      latestCorrelationId: context.correlationId,
      latestTraceId: context.traceId,
      latestSpanId: context.spanId,
      latestSessionID: context.sessionID,
      latestMessageID: context.messageID,
      latestCallID: context.callID,
      latestRequestID: context.rid,
    })
    const fingerprint = input.fingerprint ?? [input.code, input.module].join(":")
    const issue = ObservabilitySchema.Issue.parse({
      issueId: ObservabilityClock.id("iss"),
      time,
      iso: ObservabilityClock.iso(time),
      severity: input.severity,
      status: "open",
      code: input.code,
      title: ObservabilityRedaction.text(input.title),
      message: ObservabilityRedaction.text(input.message),
      recommendation: input.recommendation ? ObservabilityRedaction.text(input.recommendation) : undefined,
      module: input.module,
      correlationId: context.correlationId,
      traceId: context.traceId,
      spanId: context.spanId,
      scopeID: context.scopeID,
      sessionID: context.sessionID,
      messageID: context.messageID,
      callID: context.callID,
      rid: context.rid,
      evidence: evidence.value,
      firstSeenTime: time,
      lastSeenTime: time,
      occurrenceCount: 1,
      fingerprint,
      redaction: evidence.summary,
    })
    ObservabilityStore.insertIssue(issue)
    publishIssueRaised(fingerprint, time, issue)
    return issue
  }

  function publishIssueRaised(fingerprint: string, time: number, issue: ObservabilitySchema.Issue) {
    const lastPublishedAt = publishedFingerprints.get(fingerprint) ?? 0
    if (time - lastPublishedAt < PUBLISH_COALESCE_MS) return
    publishedFingerprints.delete(fingerprint)
    publishedFingerprints.set(fingerprint, time)
    while (publishedFingerprints.size > MAX_PUBLISHED_FINGERPRINTS) {
      const oldest = publishedFingerprints.keys().next().value
      if (!oldest) break
      publishedFingerprints.delete(oldest)
    }
    ObservabilityLiveEvents.publish({ type: "issue.raised", issue })
  }

  export function list(
    input: { status?: string; severity?: string; module?: string; scopeID?: string; limit?: number } = {},
  ) {
    return ObservabilityStore.queryIssues({
      status: input.status ?? "open",
      severity: input.severity,
      module: input.module,
      scopeID: input.scopeID,
      limit: input.limit,
    }).map(fromRow)
  }

  export function fromRow(row: ObservabilityStore.StoredIssue): ObservabilitySchema.Issue {
    return ObservabilitySchema.Issue.parse({
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
      correlationId: row.correlation_id ?? undefined,
      traceId: row.trace_id ?? undefined,
      spanId: row.span_id ?? undefined,
      scopeID: row.scope_id ?? undefined,
      sessionID: row.session_id ?? undefined,
      messageID: row.message_id ?? undefined,
      callID: row.call_id ?? undefined,
      rid: row.rid ?? undefined,
      evidence: parseJson(row.evidence_json),
      firstSeenTime: row.first_seen_time,
      lastSeenTime: row.last_seen_time,
      occurrenceCount: row.occurrence_count,
      fingerprint: row.fingerprint,
      redaction: parseRedaction(row.redaction_json),
    })
  }

  function parseRedaction(text: string | null | undefined): ObservabilitySchema.RedactionSummary {
    const parsed = text ? parseJson(text) : {}
    return ObservabilitySchema.RedactionSummary.parse({ applied: true, omittedKeys: 0, truncatedValues: 0, ...parsed })
  }
}
