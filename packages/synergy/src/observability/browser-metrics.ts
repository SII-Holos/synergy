import type { ObservabilitySchema } from "./schema"
import { ObservabilityClock } from "./clock"
import { ObservabilityMetrics } from "./metrics"
import { ObservabilityRedaction } from "./redaction"
import { ObservabilityStore } from "./store"

export interface ObservabilityBrowserMetricBatch {
  batchId?: string
  sentAt: number
  page: {
    routeName?: string
    pathTemplate?: string
    sessionID?: string
    scopeID?: string
    correlationId?: string
    navigationId?: string
    sessionSwitchId?: string
  }
  metrics: Array<{
    name: string
    value: number
    unit: ObservabilitySchema.Unit
    time?: number
    labels?: Record<string, unknown>
  }>
  resourceEntries?: Array<{
    name: string
    initiatorType?: string
    startTime: number
    duration: number
    transferSize?: number
    encodedBodySize?: number
    decodedBodySize?: number
  }>
  longTasks?: Array<{ startTime: number; duration: number; attribution?: string }>
}

export interface ObservabilityBrowserMetricIngestResult {
  batchId: string
  accepted: number
  rejected: number
  receivedAt: string
}

export namespace ObservabilityBrowserMetrics {
  const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/
  const SAFE_DIMENSION = /^[A-Za-z0-9_.:-]{1,80}$/
  const SECRET_LIKE_ID = /^(authorization|bearer|basic|prompt|completion|content|body|sk-|ghp_|xoxb-|tok_|key_)/i
  const ENUM_LABELS = new Map<string, Set<string>>([
    ["phase", new Set(["receive", "apply", "paint", "fetch", "sync", "render", "complete", "timeout"])],
    ["tokenphase", new Set(["receive", "apply", "paint"])],
    ["parttype", new Set(["text", "tool-call", "tool-result", "reasoning", "file", "unknown"])],
    ["reason", new Set(["complete", "timeout", "navigation", "manual", "route", "unknown"])],
    ["trigger", new Set(["route", "user", "history", "sync", "unknown"])],
    ["rating", new Set(["good", "needs-improvement", "poor"])],
    ["navigationtype", new Set(["navigate", "reload", "back_forward", "prerender", "unknown"])],
  ])

  export function ingest(input: ObservabilityBrowserMetricBatch): ObservabilityBrowserMetricIngestResult {
    const receivedTime = ObservabilityClock.now()
    const batchId = input.batchId ?? ObservabilityClock.id("brb")
    let accepted = 0
    let rejected = 0
    const page = normalizePage(input.page)
    for (const metric of input.metrics) {
      if (!isAllowedBrowserMetric(metric.name) || !Number.isFinite(metric.value)) {
        rejected++
        continue
      }
      try {
        const labels = browserLabels(metric.labels)
        const context = metricContext(page, labels)
        ObservabilityMetrics.record({
          name: metric.name,
          value: metric.value,
          unit: metric.unit,
          module: "frontend",
          source: "browser",
          labels: { ...labels, ...pageLabels(page) },
          sessionID: context.sessionID,
          scopeID: context.scopeID,
          correlationId: context.correlationId,
        })
        accepted++
      } catch {
        rejected++
      }
    }
    for (const entry of input.resourceEntries ?? []) {
      if (
        (!entry.name.startsWith("http") && !entry.name.startsWith("/")) ||
        !Number.isFinite(entry.duration) ||
        entry.duration < 0
      ) {
        rejected++
        continue
      }
      ObservabilityMetrics.record({
        name: "frontend.resource.duration",
        value: entry.duration,
        unit: "ms",
        module: "frontend",
        source: "browser",
        labels: {
          name: ObservabilityRedaction.routePath(entry.name),
          initiatorType: safeDimension(entry.initiatorType) ?? "unknown",
          transferSize: entry.transferSize ?? 0,
          ...pageLabels(page),
        },
        sessionID: page.sessionID,
        scopeID: page.scopeID,
        correlationId: page.correlationId,
      })
      accepted++
    }
    for (const task of input.longTasks ?? []) {
      if (!Number.isFinite(task.duration) || task.duration < 0) {
        rejected++
        continue
      }
      ObservabilityMetrics.record({
        name: "frontend.long_task.duration",
        value: task.duration,
        unit: "ms",
        module: "frontend",
        source: "browser",
        labels: { attribution: safeDimension(task.attribution) ?? "unknown", ...pageLabels(page) },
        sessionID: page.sessionID,
        scopeID: page.scopeID,
        correlationId: page.correlationId,
      })
      accepted++
    }
    ObservabilityStore.insertBrowserBatch({ batchId, receivedTime, sentAt: input.sentAt, accepted, rejected, page })
    return { batchId, accepted, rejected, receivedAt: ObservabilityClock.iso(receivedTime) }
  }

  function isAllowedBrowserMetric(name: string) {
    return name.startsWith("frontend.") || name.startsWith("web_vital.") || name.startsWith("browser.")
  }

  function normalizePage(page: ObservabilityBrowserMetricBatch["page"]) {
    const pathTemplate = page.pathTemplate ?? page.routeName
    return {
      routeName: page.routeName ? safeRouteName(page.routeName) : undefined,
      pathTemplate: pathTemplate ? ObservabilityRedaction.routePath(pathTemplate) : undefined,
      sessionID: safeId(page.sessionID),
      scopeID: safeId(page.scopeID),
      correlationId: safeId(page.correlationId),
      navigationId: safeId(page.navigationId),
      sessionSwitchId: safeId(page.sessionSwitchId),
    }
  }

  function pageLabels(page: ReturnType<typeof normalizePage>) {
    return {
      routeName: page.routeName,
      pathTemplate: page.pathTemplate,
      navigationId: page.navigationId,
      sessionSwitchId: page.sessionSwitchId,
    }
  }

  function browserLabels(labels: Record<string, unknown> | undefined) {
    const clean: Record<string, string | number | boolean | null> = {}
    for (const [key, value] of Object.entries(labels ?? {}).slice(0, 12)) {
      if (!isAllowedBrowserLabel(key)) continue
      const safeKey = key.slice(0, 48)
      if (typeof value === "string") {
        const normalizedKey = labelKey(key)
        const safeValue = browserLabelValue(normalizedKey, value)
        if (safeValue !== undefined) clean[safeKey] = safeValue
        continue
      }
      if (typeof value === "number" && Number.isFinite(value)) clean[safeKey] = value
      else if (typeof value === "boolean" || value === null) clean[safeKey] = value
    }
    return clean
  }

  const allowedBrowserLabels = new Set([
    "name",
    "rating",
    "attribution",
    "route",
    "path",
    "initiator",
    "size",
    "duration",
    "value",
    "type",
    "component",
    "routename",
    "pathtemplate",
    "initiatortype",
    "transfersize",
    "encodedbodysize",
    "decodedbodysize",
    "navigationtype",
    "dominteractive",
    "domcontentloaded",
    "loadcomplete",
    "correlationid",
    "navigationid",
    "sessionswitchid",
    "sessionid",
    "scopeid",
    "messageid",
    "phase",
    "tokenphase",
    "deltachars",
    "parttype",
    "reason",
    "trigger",
  ])

  const contextLabels = new Set([
    "correlationid",
    "navigationid",
    "sessionswitchid",
    "sessionid",
    "scopeid",
    "messageid",
  ])

  function labelKey(key: string) {
    return key.toLowerCase().replace(/[-_]/g, "")
  }

  function safeId(value: string | undefined) {
    if (!value) return undefined
    if (SECRET_LIKE_ID.test(value)) return undefined
    return SAFE_ID.test(value) ? value : undefined
  }

  function safeRouteName(value: string) {
    const clean = ObservabilityRedaction.text(value, 120).replace(/[\x00-\x1f<>]/g, "")
    return SAFE_DIMENSION.test(clean) ? clean : undefined
  }

  function safeDimension(value: string | undefined) {
    if (!value) return undefined
    if (SECRET_LIKE_ID.test(value)) return undefined
    return SAFE_DIMENSION.test(value) ? value : undefined
  }

  function browserLabelValue(normalizedKey: string, value: string) {
    if (contextLabels.has(normalizedKey)) return safeId(value)
    if (looksLikeUrlKey(normalizedKey)) return ObservabilityRedaction.routePath(value)
    const allowed = ENUM_LABELS.get(normalizedKey)
    if (allowed) return allowed.has(value) ? value : undefined
    return safeDimension(value)
  }

  function isAllowedBrowserLabel(key: string) {
    return allowedBrowserLabels.has(labelKey(key))
  }

  function looksLikeUrlKey(key: string) {
    return key.includes("url") || key.includes("path") || key.includes("route")
  }

  function metricContext(
    page: ReturnType<typeof normalizePage>,
    labels: Record<string, string | number | boolean | null>,
  ) {
    return {
      sessionID: page.sessionID ?? stringLabel(labels.sessionID),
      scopeID: page.scopeID ?? stringLabel(labels.scopeID),
      correlationId: page.correlationId ?? stringLabel(labels.correlationId),
    }
  }

  function stringLabel(value: string | number | boolean | null | undefined) {
    return typeof value === "string" ? safeId(value) : undefined
  }
}
