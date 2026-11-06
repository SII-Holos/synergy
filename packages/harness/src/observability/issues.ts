import { RuntimeContext } from "../lifecycle/context"
import { ObservabilityClock } from "./clock"
import { ObservabilityLiveEvents } from "./live-events"
import { ObservabilityContext } from "./context"
import { ObservabilityRedaction } from "./redaction"
import { ObservabilitySchema } from "./schema"
import { parseJson } from "../util/json-parse"
import { ObservabilityStore } from "./store"
import { ObservabilityConfig } from "./config"

export namespace ObservabilityIssues {
  const runtimeState = RuntimeContext.state(() => ({
    publishedFingerprints: new Map<string, number>(),
    conditions: new Map<string, ConditionEpisode | null>(),
    pendingConditions: new Set<ConditionEpisode>(),
    conditionsRegistered: false,
  }))
  const PUBLISH_COALESCE_MS = 60_000
  const MAX_PUBLISHED_FINGERPRINTS = 1_000

  export type ConditionOwner = ObservabilitySchema.ConditionOwner

  export interface ConditionObservation {
    owner: ConditionOwner
    code: string
    module: ObservabilitySchema.Module
    title: string
    recommendation?: string
    severity: ObservabilitySchema.IssueSeverity
    state: "active" | "normal" | "unknown"
    observedValue?: number
    thresholdValue?: number
    unit: ObservabilitySchema.Unit
    scopeID?: string
  }

  interface ConditionEpisode {
    issue: ObservabilitySchema.Issue
    pendingCount: number
  }

  const severityRank = { info: 0, warning: 1, error: 2, critical: 3 } satisfies Record<
    ObservabilitySchema.IssueSeverity,
    number
  >

  export function observeCondition(input: ConditionObservation) {
    if (!RuntimeContext.tryCurrent() || !ObservabilityStore.accepting() || input.state === "unknown") return
    const { observedValue, thresholdValue } = input
    if (
      observedValue === undefined ||
      thresholdValue === undefined ||
      !Number.isFinite(observedValue) ||
      !Number.isFinite(thresholdValue)
    )
      return
    const state = runtimeState()
    if (!state.conditionsRegistered) {
      state.conditionsRegistered = true
      ObservabilityStore.beforeFlush(flushConditions)
    }
    const context = {
      ...ObservabilityContext.current(),
      scopeID: input.scopeID ?? ObservabilityContext.current().scopeID,
    }
    const fingerprint = ObservabilitySchema.conditionFingerprint({
      scopeID: context.scopeID,
      owner: input.owner,
      code: input.code,
    })
    if (!state.conditions.has(fingerprint)) {
      const stored = ObservabilityStore.findPersistedOpenIssue(fingerprint)
      state.conditions.set(fingerprint, stored ? { issue: fromRow(stored), pendingCount: 0 } : null)
    }
    let episode = state.conditions.get(fingerprint)
    const time = ObservabilityClock.now()
    if (input.state === "normal") {
      if (!episode || episode.issue.evidence.unit !== input.unit) return
      flushCondition(episode)
      const recovery = {
        resolvedTime: time,
        recoveryObservedValue: observedValue,
        recoveryThresholdValue: thresholdValue,
      }
      ObservabilityStore.updateIssueStatus({ fingerprint, status: "resolved", evidence: recovery })
      const snapshot = conditionSnapshot(episode)
      ObservabilityLiveEvents.publish({
        type: "issue.resolved",
        issue: {
          ...snapshot,
          status: "resolved",
          evidence: { ...snapshot.evidence, ...recovery },
        },
      })
      state.conditions.set(fingerprint, null)
      return
    }
    const entered = !episode
    if (!episode) {
      const title = ObservabilityRedaction.text(input.title)
      episode = {
        pendingCount: 0,
        issue: {
          issueId: ObservabilityClock.id("iss"),
          time,
          iso: ObservabilityClock.iso(time),
          code: input.code,
          severity: input.severity,
          status: "open",
          module: input.module,
          title,
          message: "",
          recommendation: input.recommendation ? ObservabilityRedaction.text(input.recommendation) : undefined,
          scopeID: context.scopeID,
          firstSeenTime: time,
          lastSeenTime: time,
          occurrenceCount: 0,
          fingerprint,
          evidence: {
            owner: input.owner,
            unit: input.unit,
            firstObservedValue: observedValue,
            firstThresholdValue: thresholdValue,
            peakObservedValue: observedValue,
            peakObservedTime: time,
            peakThresholdValue: thresholdValue,
          },
          redaction: { applied: true, omittedKeys: 0, truncatedValues: 0 },
        },
      }
      state.conditions.set(fingerprint, episode)
    }
    const issue = episode.issue
    if (issue.evidence.unit !== input.unit) return
    const escalated = severityRank[input.severity] > severityRank[issue.severity]
    issue.severity = input.severity
    issue.lastSeenTime = time
    issue.occurrenceCount++
    issue.correlationId = context.correlationId
    issue.traceId = context.traceId
    issue.spanId = context.spanId
    issue.sessionID = context.sessionID
    issue.messageID = context.messageID
    issue.callID = context.callID
    issue.rid = context.rid
    Object.assign(issue.evidence, {
      observedValue,
      thresholdValue,
      latestCorrelationId: context.correlationId ?? null,
      latestTraceId: context.traceId ?? null,
      latestSpanId: context.spanId ?? null,
      latestScopeID: context.scopeID ?? null,
      latestSessionID: context.sessionID ?? null,
      latestMessageID: context.messageID ?? null,
      latestCallID: context.callID ?? null,
      latestRequestID: context.rid ?? null,
    })
    if (observedValue > Number(issue.evidence.peakObservedValue)) {
      issue.evidence.peakObservedValue = observedValue
      issue.evidence.peakObservedTime = time
      issue.evidence.peakThresholdValue = thresholdValue
    }
    episode.pendingCount++
    state.pendingConditions.add(episode)
    if (entered || escalated)
      ObservabilityLiveEvents.publish({ type: "issue.raised", issue: conditionSnapshot(episode) })
    ObservabilityStore.requestFlush()
  }

  function conditionSnapshot(episode: ConditionEpisode) {
    const issue = episode.issue
    const evidence = ObservabilityRedaction.redactRecord(issue.evidence)
    return ObservabilitySchema.Issue.parse({
      ...issue,
      message: `${issue.title}: ${evidence.value.observedValue} ${evidence.value.unit} (threshold ${evidence.value.thresholdValue} ${evidence.value.unit}).`,
      evidence: evidence.value,
      redaction: evidence.summary,
    })
  }

  function flushCondition(episode: ConditionEpisode) {
    runtimeState().pendingConditions.delete(episode)
    if (!episode.pendingCount) return
    const issue = conditionSnapshot(episode)
    ObservabilityStore.insertIssue({ ...issue, occurrenceCount: episode.pendingCount })
    episode.pendingCount = 0
  }

  function flushConditions() {
    for (const episode of runtimeState().pendingConditions) flushCondition(episode)
  }

  export function resetConditions() {
    const state = runtimeState()
    state.conditions.clear()
    state.pendingConditions.clear()
  }

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
    // When observability is disabled, skip construction, persistence, and
    // live-event publishing entirely so the write path and the dashboard
    // data version stay quiet (a growing data version would defeat the
    // summary cache even when nothing is stored).
    if (!RuntimeContext.tryCurrent() || !ObservabilityConfig.current().enabled) return undefined
    const context = ObservabilityContext.merge(
      ObservabilityContext.compact({
        correlationId: input.correlationId,
        traceId: input.traceId,
        spanId: input.spanId,
        scopeID: input.scopeID,
        sessionID: input.sessionID,
        messageID: input.messageID,
        callID: input.callID,
        rid: input.rid,
        module: input.module,
        source: "backend" as const,
      }),
    )
    const time = ObservabilityClock.now()
    const evidence = ObservabilityRedaction.redactRecord({
      ...input.evidence,
      latestCorrelationId: context.correlationId,
      latestTraceId: context.traceId,
      latestSpanId: context.spanId,
      latestScopeID: context.scopeID,
      latestSessionID: context.sessionID,
      latestMessageID: context.messageID,
      latestCallID: context.callID,
      latestRequestID: context.rid,
    })
    const fingerprint =
      input.fingerprint ??
      [input.code, input.module, context.scopeID === undefined ? "global" : `scope:${context.scopeID}`].join(":")
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
    const instanceState = runtimeState()

    const lastPublishedAt = instanceState.publishedFingerprints.get(fingerprint) ?? 0
    if (time - lastPublishedAt < PUBLISH_COALESCE_MS) return
    instanceState.publishedFingerprints.delete(fingerprint)
    instanceState.publishedFingerprints.set(fingerprint, time)
    while (instanceState.publishedFingerprints.size > MAX_PUBLISHED_FINGERPRINTS) {
      const oldest = instanceState.publishedFingerprints.keys().next().value
      if (!oldest) break
      instanceState.publishedFingerprints.delete(oldest)
    }
    ObservabilityLiveEvents.publish({ type: "issue.raised", issue })
  }

  export function list(
    input: {
      status?: string
      severity?: string
      module?: string
      scopeID?: string
      tool?: string
      since?: number
      until?: number
      limit?: number
    } = {},
  ) {
    return ObservabilityStore.queryIssues({
      status: input.status ?? "open",
      severity: input.severity,
      module: input.module,
      scopeID: input.scopeID,
      tool: input.tool,
      since: input.since,
      until: input.until,
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
