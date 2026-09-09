import type { ObservabilitySchema } from "./schema"
import { ObservabilityClock } from "./clock"
import { ObservabilityConfig } from "./config"
import { ObservabilityEvents } from "./events"
import { ObservabilityMetrics } from "./metrics"
import { ObservabilityRedaction } from "./redaction"
import { ObservabilitySpans } from "./spans"
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

export interface BrowserTelemetryOwner {
  mode: "session" | "scope"
  scopeID: string
  sessionID?: string
}

export namespace ObservabilityBrowserTelemetry {
  const DIMENSION = /^[A-Za-z0-9_.:-]{1,64}$/
  const LOCATOR_KINDS = new Set(["ref", "testId", "role", "label", "placeholder", "text", "css", "xpath", "point"])

  export function commandLabels(command: unknown): Record<string, string | number | boolean> {
    const labels: Record<string, string | number | boolean> = {}
    if (!command || typeof command !== "object") return labels
    const record = command as Record<string, unknown>
    const type = dimensionString(record.type)
    if (type) labels.type = type
    const action = commandAction(record)
    if (action) labels.action = action
    const locator = commandLocator(record)
    const kind = locatorKind(locator)
    if (kind) labels.kind = kind
    const length = locatorLength(locator)
    if (length !== undefined) labels.valueLength = length
    if (typeof record.url === "string" && record.url) labels.url = ObservabilityRedaction.routePath(record.url)
    const source = dimensionString(record.source)
    if (source) labels.source = source
    const settleMode = dimensionString(record.settleMode)
    if (settleMode) labels.settleMode = settleMode
    if (type === "evaluate" && typeof record.expression === "string") {
      labels.valueLength = Math.min(record.expression.length, 1_000_000)
    }
    return labels
  }

  export function settleSummary(result: unknown): Record<string, string | number | boolean> {
    if (!result || typeof result !== "object") return {}
    const record = result as Record<string, unknown>
    const summary: Record<string, string | number | boolean> = {}
    if (typeof record.settled === "boolean") summary.settled = record.settled
    const settleReason = dimensionString(record.settleReason)
    if (settleReason) summary.settleReason = settleReason
    const settleElapsedMs = boundedNumber(record.settleElapsedMs, 0, 10_000_000)
    if (settleElapsedMs !== undefined) summary.settleElapsedMs = settleElapsedMs
    const inflightRequests = boundedNumber(record.inflightRequests, 0, 100_000)
    if (inflightRequests !== undefined) summary.inflightRequests = inflightRequests
    if (typeof record.matched === "boolean") summary.matched = record.matched
    const elapsedMs = boundedNumber(record.elapsedMs, 0, 10_000_000)
    if (elapsedMs !== undefined) summary.elapsedMs = elapsedMs
    return summary
  }

  export function ownerContext(owner: BrowserTelemetryOwner | undefined): { scopeID?: string; sessionID?: string } {
    if (!owner) return {}
    return {
      scopeID: typeof owner.scopeID === "string" ? telemetrySafeId(owner.scopeID) : undefined,
      sessionID:
        owner.mode === "session" && typeof owner.sessionID === "string" ? telemetrySafeId(owner.sessionID) : undefined,
    }
  }

  export function recordCommand(owner: BrowserTelemetryOwner | undefined, command: unknown): void {
    recordMetric("browser.command.count", 1, "count", owner, commandLabels(command))
  }

  export function startCommand(owner: BrowserTelemetryOwner | undefined, command: unknown) {
    try {
      const context = ownerContext(owner)
      return ObservabilitySpans.start({
        name: "browser.command",
        module: "browser",
        source: "browser",
        scopeID: context.scopeID,
        sessionID: context.sessionID,
        attributes: commandLabels(command),
      })
    } catch {
      return undefined
    }
  }

  export function endCommand(
    span: ReturnType<typeof ObservabilitySpans.start>,
    error?: unknown,
    result?: unknown,
  ): void {
    if (!span) return
    try {
      ObservabilitySpans.end(span, {
        ...(error ? { status: "error" as const, error } : { status: "ok" as const }),
        ...(result ? { attributes: settleSummary(result) } : {}),
      })
    } catch {}
  }

  export function recordCommandFailure(
    owner: BrowserTelemetryOwner | undefined,
    command: unknown,
    errorCode: string | undefined,
    ambiguousCandidates?: number,
  ): void {
    const labels = commandLabels(command)
    const code = dimensionString(errorCode)
    recordMetric("browser.command.failed.count", 1, "count", owner, {
      ...labels,
      ...(code ? { errorCode: code } : {}),
    })
    if (ambiguousCandidates === undefined) return
    recordMetric("browser.locator.ambiguous.count", 1, "count", owner, {
      ...labels,
      candidateCount: Math.min(Math.max(Math.round(ambiguousCandidates), 0), 10_000),
    })
  }

  export function recordSettle(owner: BrowserTelemetryOwner | undefined, command: unknown, result: unknown): void {
    const summary = settleSummary(result)
    const elapsed = typeof summary.settleElapsedMs === "number" ? summary.settleElapsedMs : undefined
    if (elapsed === undefined) return
    recordMetric("browser.settle.duration", elapsed, "ms", owner, {
      ...commandLabels(command),
      ...(typeof summary.settleReason === "string" ? { settleReason: summary.settleReason } : {}),
      ...(typeof summary.settled === "boolean" ? { settled: summary.settled } : {}),
    })
  }

  export function recordHostStatus(status: unknown, owner?: BrowserTelemetryOwner): void {
    const label = dimensionString(status)
    const safeStatus = label ?? "unknown"
    recordMetric("browser.host.status.count", 1, "count", owner, { status: safeStatus })
    emitBrowserEvent("browser.host.status", owner, { status: safeStatus })
    if (safeStatus === "restarting") recordRecovery(owner, "started")
    if (safeStatus === "ready") recordRecovery(owner, "completed")
    if (safeStatus === "failed") recordRecovery(owner, "failed")
  }

  export function recordRecovery(
    owner: BrowserTelemetryOwner | undefined,
    status: "started" | "completed" | "failed",
  ): void {
    recordMetric(`browser.recovery.${status}`, 1, "count", owner, { status })
    emitBrowserEvent(`browser.recovery.${status}`, owner, { status })
  }

  export function recordBrokerTimeout(requestType: string, commandType?: string, owner?: BrowserTelemetryOwner): void {
    const labels: Record<string, string | number | boolean> = {}
    const type = dimensionString(requestType)
    if (type) labels.requestType = type
    const command = dimensionString(commandType)
    if (command) labels.commandType = command
    recordMetric("browser.broker.timeout.count", 1, "count", owner, labels)
    emitBrowserEvent("browser.broker.timeout", owner, labels)
  }

  export function recordHostDisconnected(owner?: BrowserTelemetryOwner): void {
    recordMetric("browser.host.disconnected", 1, "count", owner)
    emitBrowserEvent("browser.host.disconnected", owner)
  }

  export function recordResourceCleanup(owner: BrowserTelemetryOwner | undefined, outcome: "ok" | "failed"): void {
    recordMetric("browser.resource.cleanup", 1, "count", owner, { outcome })
    emitBrowserEvent("browser.resource.cleanup", owner, { outcome })
  }

  export function recordWebRTCReconnect(owner: BrowserTelemetryOwner | undefined, role: "viewer" | "host"): void {
    recordMetric("browser.webrtc.reconnect.count", 1, "count", owner, { role })
    emitBrowserEvent("browser.webrtc.reconnect", owner, { role })
  }

  export function emitBrowserEvent(
    type: string,
    owner: BrowserTelemetryOwner | undefined,
    data: Record<string, unknown> = {},
  ): void {
    if (!ObservabilityConfig.current().enabled) return
    const context = ownerContext(owner)
    void ObservabilityEvents.emit(type, {
      module: "browser",
      source: "backend",
      scopeID: context.scopeID,
      sessionID: context.sessionID,
      data,
    }).catch(() => undefined)
  }

  function recordMetric(
    name: string,
    value: number,
    unit: ObservabilitySchema.Unit,
    owner: BrowserTelemetryOwner | undefined,
    labels: Record<string, unknown> = {},
  ): void {
    try {
      const context = ownerContext(owner)
      ObservabilityMetrics.record({
        name,
        value,
        unit,
        module: "browser",
        source: "backend",
        labels,
        scopeID: context.scopeID,
        sessionID: context.sessionID,
      })
    } catch {}
  }

  function commandAction(record: Record<string, unknown>): string | undefined {
    const action = record.action
    if (typeof action === "string") return dimensionString(action)
    if (action && typeof action === "object" && !Array.isArray(action)) {
      return dimensionString((action as Record<string, unknown>).type)
    }
    const condition = record.condition
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      return dimensionString((condition as Record<string, unknown>).type)
    }
    const direction = dimensionString(record.direction)
    if (direction) return direction
    const format = dimensionString(record.format)
    if (format) return format
    const mode = dimensionString(record.mode)
    if (mode) return mode
    if (typeof record.accept === "boolean") return record.accept ? "accept" : "dismiss"
    return undefined
  }

  function commandLocator(record: Record<string, unknown>): Record<string, unknown> | undefined {
    for (const key of ["locator", "target"]) {
      const value = record[key]
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
    }
    const action = record.action
    if (action && typeof action === "object" && !Array.isArray(action)) {
      for (const key of ["target", "locator"]) {
        const value = (action as Record<string, unknown>)[key]
        if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
      }
    }
    const condition = record.condition
    if (condition && typeof condition === "object" && !Array.isArray(condition)) {
      const value = (condition as Record<string, unknown>).locator
      if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
    }
    return undefined
  }

  function locatorKind(locator: Record<string, unknown> | undefined): string | undefined {
    const kind = typeof locator?.kind === "string" ? locator.kind : undefined
    if (!kind || !LOCATOR_KINDS.has(kind)) return undefined
    return kind
  }

  function locatorLength(locator: Record<string, unknown> | undefined): number | undefined {
    if (!locator) return undefined
    const key =
      locator.kind === "ref"
        ? "ref"
        : locator.kind === "role"
          ? "name"
          : locator.kind === "label" || locator.kind === "placeholder" || locator.kind === "text"
            ? "text"
            : "value"
    const value = locator[key]
    if (typeof value !== "string") return undefined
    return Math.min(value.length, 1_000_000)
  }

  function telemetrySafeId(value: string): string | undefined {
    const clean = value.slice(0, 128)
    return /^[A-Za-z0-9_.:-]{1,128}$/.test(clean) ? clean : undefined
  }

  function dimensionString(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined
    const clean = value.slice(0, 64)
    return DIMENSION.test(clean) ? clean : undefined
  }

  function boundedNumber(value: unknown, min: number, max: number): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined
    return Math.min(max, Math.max(min, Math.round(value)))
  }
}
