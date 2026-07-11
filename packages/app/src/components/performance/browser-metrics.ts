import type { PerfBrowserMetricBatch } from "@ericsanchezok/synergy-sdk"
import type { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"

type SynergyClient = ReturnType<typeof createSynergyClient>
type BrowserMetric = PerfBrowserMetricBatch["metrics"][number]

type ResourceEntry = {
  name: string
  initiatorType?: string
  startTime: number
  duration: number
  transferSize?: number
  encodedBodySize?: number
  decodedBodySize?: number
}

type LongTaskEntry = {
  startTime: number
  duration: number
  attribution?: string
}

export type BrowserTelemetryContext = {
  sessionID?: string
  scopeID?: string
  correlationId?: string
  navigationId?: string
  sessionSwitchId?: string
}

type QueueEntry =
  | { kind: "metric"; value: BrowserMetric }
  | { kind: "resource"; value: ResourceEntry }
  | { kind: "longTask"; value: LongTaskEntry }

type TokenReceipt = {
  time: number
  context: BrowserTelemetryContext
  deltaChars: number
  partType?: string
}
const MAX_BATCH = 100
const MAX_PAYLOAD_BYTES = 256 * 1024
const FLUSH_INTERVAL_MS = 10_000
const MAX_LABEL_LENGTH = 160
const RECENT_LONG_TASK_WINDOW_MS = 60_000
const MAX_TOKEN_RECEIPTS = 500

let started = false
let timer: number | undefined
let queue: QueueEntry[] = []
let locallyRejected = 0
let cleanup: Array<() => void> = []
const recentLongTasks: LongTaskEntry[] = []
const tokenReceipts = new Map<string, TokenReceipt>()
export function startBrowserPerformanceMetrics(input: { url: string; client: SynergyClient }) {
  if (started || typeof window === "undefined") return
  started = true

  const flush = () => void flushBrowserMetrics(input)
  observeWebVitals()
  observePerformanceEntries()
  timer = window.setInterval(flush, FLUSH_INTERVAL_MS)
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") flush()
  }
  const onLocationChange = () => flush()
  window.addEventListener("visibilitychange", onVisibilityChange)
  window.addEventListener("pagehide", flush)
  window.addEventListener("popstate", onLocationChange)
  window.addEventListener("hashchange", onLocationChange)
  wrapHistoryNavigation("pushState", onLocationChange)
  wrapHistoryNavigation("replaceState", onLocationChange)
  cleanup.push(() => window.removeEventListener("visibilitychange", onVisibilityChange))
  cleanup.push(() => window.removeEventListener("pagehide", flush))
  cleanup.push(() => window.removeEventListener("popstate", onLocationChange))
  cleanup.push(() => window.removeEventListener("hashchange", onLocationChange))
}

function enqueue(entry: QueueEntry) {
  if (queue.length >= MAX_BATCH * 4) {
    locallyRejected++
    return
  }
  queue.push(entry)
}

export function recordSessionSwitchTiming(input: {
  sessionID: string
  scopeID?: string
  correlationId: string
  navigationId: string
  sessionSwitchId: string
  startTime: number
  endTime: number
  marks: Record<string, number>
  reason: "complete" | "timeout"
  trigger?: string
}) {
  for (const metric of buildSessionSwitchMetrics({
    ...input,
    longTaskOverlapMs: longTaskOverlap(input.startTime, input.endTime),
  })) {
    enqueue({ kind: "metric", value: metric })
  }
}

export function buildSessionSwitchMetrics(input: {
  sessionID: string
  scopeID?: string
  correlationId: string
  navigationId: string
  sessionSwitchId: string
  startTime: number
  endTime: number
  marks: Record<string, number>
  reason: "complete" | "timeout"
  trigger?: string
  longTaskOverlapMs?: number
}) {
  const context = contextLabels(input)
  const total = finiteDuration(input.endTime - input.startTime)
  if (total === undefined) return []
  const metrics: BrowserMetric[] = [
    metricValue("frontend.session_switch.duration", total, "ms", {
      ...context,
      reason: input.reason,
      trigger: input.trigger ?? null,
    }),
  ]
  for (const [phase, time] of Object.entries(input.marks).sort(([a], [b]) => a.localeCompare(b))) {
    const duration = finiteDuration(time - input.startTime)
    if (duration === undefined) continue
    metrics.push(metricValue("frontend.session_switch.phase.duration", duration, "ms", { ...context, phase }))
  }
  const overlap = finiteDuration(input.longTaskOverlapMs ?? 0)
  if (overlap && overlap > 0) {
    metrics.push(metricValue("frontend.session_switch.long_task_overlap", overlap, "ms", context))
  }
  return metrics
}

export function recordTokenReceive(
  part: { id: string; sessionID?: string; messageID?: string; type?: string },
  input: { delta?: string; correlationId?: string; navigationId?: string; sessionSwitchId?: string } = {},
) {
  const time = browserNow()
  const context: BrowserTelemetryContext = {
    sessionID: safeContextID(part.sessionID),
    correlationId: safeContextID(input.correlationId ?? part.messageID ?? part.sessionID),
    navigationId: safeContextID(input.navigationId),
    sessionSwitchId: safeContextID(input.sessionSwitchId),
  }
  const receipt: TokenReceipt = {
    time,
    context,
    deltaChars: input.delta?.length ?? 0,
    partType: safeString(part.type ?? "unknown"),
  }
  tokenReceipts.set(tokenKey(part), receipt)
  while (tokenReceipts.size > MAX_TOKEN_RECEIPTS) {
    const oldest = tokenReceipts.keys().next().value
    if (!oldest) break
    tokenReceipts.delete(oldest)
  }
  const metric = buildTokenTimingMetric({ phase: "receive", value: 1, unit: "count", part, receipt })
  if (metric) enqueue({ kind: "metric", value: metric })
}

export function recordTokenApply(part: { id: string; sessionID?: string; messageID?: string; type?: string }) {
  const key = tokenKey(part)
  const receipt = tokenReceipts.get(key)
  if (!receipt) return
  const appliedAt = browserNow()
  const applyMetric = buildTokenTimingMetric({
    phase: "apply",
    value: appliedAt - receipt.time,
    unit: "ms",
    part,
    receipt,
  })
  if (applyMetric) enqueue({ kind: "metric", value: applyMetric })
  const paint = () => {
    const paintMetric = buildTokenTimingMetric({
      phase: "paint",
      value: browserNow() - receipt.time,
      unit: "ms",
      part,
      receipt,
    })
    if (paintMetric) enqueue({ kind: "metric", value: paintMetric })
    tokenReceipts.delete(key)
  }
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(() => paint())
  } else {
    setTimeout(paint, 0)
  }
}

export function buildTokenTimingMetric(input: {
  phase: "receive" | "apply" | "paint"
  value: number
  unit: BrowserMetric["unit"]
  part: { id: string; sessionID?: string; messageID?: string; type?: string }
  receipt: TokenReceipt
}) {
  const value =
    input.unit === "ms"
      ? finiteDuration(input.value)
      : Number.isFinite(input.value) && input.value >= 0
        ? input.value
        : undefined
  if (value === undefined) return undefined
  return metricValue(`frontend.token.${input.phase}.${input.unit === "ms" ? "duration" : "count"}`, value, input.unit, {
    ...contextLabels(input.receipt.context),
    phase: input.phase,
    tokenPhase: input.phase,
    deltaChars: input.receipt.deltaChars,
    partType: input.receipt.partType ?? safeString(input.part.type ?? "unknown"),
    messageID: safeContextID(input.part.messageID) ?? null,
  })
}

async function flushBrowserMetrics(input: { url: string; client: SynergyClient }) {
  if (queue.length === 0 && locallyRejected === 0) return
  const entries = queue.splice(0, MAX_BATCH)
  const metrics = entries.flatMap((entry) => (entry.kind === "metric" ? [entry.value] : []))
  const rejected = locallyRejected
  if (rejected > 0) {
    metrics.push(metricValue("frontend.collector.rejected", rejected, "count", { reason: "local_limit" }))
  }
  const resourceEntries = entries.flatMap((entry) => (entry.kind === "resource" ? [entry.value] : []))
  const longTasks = entries.flatMap((entry) => (entry.kind === "longTask" ? [entry.value] : []))
  const body = {
    sentAt: Date.now(),
    page: pageContext(),
    metrics,
    resourceEntries,
    longTasks,
  }
  if (encodedSize(body) > MAX_PAYLOAD_BYTES) {
    queue = [...entries, ...queue]
    return
  }
  try {
    await input.client.performance.browserMetrics.ingest({ perfBrowserMetricBatch: body }, { throwOnError: true })
    locallyRejected = Math.max(0, locallyRejected - rejected)
  } catch {
    queue = [...entries, ...queue].slice(0, MAX_BATCH * 4)
  }
}

function observeWebVitals() {
  void import("web-vitals/attribution")
    .then((webVitals) => {
      const report = (metric: { name: string; value: number; rating?: string; attribution?: unknown }) => {
        enqueue({
          kind: "metric",
          value: metricValue("frontend.web_vital", metric.value, metric.name === "CLS" ? "ratio" : "ms", {
            name: metric.name,
            rating: metric.rating ?? null,
            attribution: safeString(JSON.stringify(metric.attribution ?? {})),
          }),
        })
      }
      webVitals.onCLS(report)
      webVitals.onFCP(report)
      webVitals.onINP(report)
      webVitals.onLCP(report)
      webVitals.onTTFB(report)
    })
    .catch(() => undefined)
}

function observePerformanceEntries() {
  observe("resource", (entry) => {
    if (!(entry instanceof PerformanceResourceTiming)) return
    enqueue({
      kind: "resource",
      value: {
        name: stripUrl(entry.name),
        initiatorType: safeString(entry.initiatorType),
        startTime: entry.startTime,
        duration: entry.duration,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
      },
    })
  })
  observe("measure", (entry) => {
    enqueue({
      kind: "metric",
      value: metricValue("frontend.user_timing.duration", entry.duration, "ms", { name: safeString(entry.name) }),
    })
  })
  observe("longtask", (entry) => {
    const value = { startTime: entry.startTime, duration: entry.duration, attribution: "longtask" }
    enqueue({ kind: "longTask", value })
    rememberLongTask(value)
  })
  observe("long-animation-frame", (entry) => {
    const value = { startTime: entry.startTime, duration: entry.duration, attribution: "long-animation-frame" }
    enqueue({ kind: "longTask", value })
    rememberLongTask(value)
  })
}

function observe(type: string, onEntry: (entry: PerformanceEntry) => void) {
  if (typeof PerformanceObserver === "undefined") return
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) onEntry(entry)
    })
    observer.observe({ type, buffered: true })
    cleanup.push(() => observer.disconnect())
  } catch {
    return
  }
}

function metricValue(
  name: string,
  value: number,
  unit: BrowserMetric["unit"],
  labels: Record<string, string | number | boolean | null>,
): BrowserMetric {
  return {
    name,
    value,
    unit,
    labels,
  }
}

export function pageContext(): PerfBrowserMetricBatch["page"] {
  return pageContextFromUrl(location.pathname, location.search)
}

export function pageContextFromUrl(pathname: string, search = ""): PerfBrowserMetricBatch["page"] {
  const params = new URLSearchParams(search)
  const context: NonNullable<PerfBrowserMetricBatch["page"]> = {
    routeName: routeName(pathname),
    pathTemplate: normalizePath(pathname),
  }
  const sessionID = safeContextID(params.get("sessionID") ?? params.get("session"))
  const scopeID = safeContextID(params.get("scopeID") ?? params.get("scope"))
  if (sessionID) context.sessionID = sessionID
  if (scopeID) context.scopeID = scopeID
  return context
}

function routeName(pathname: string) {
  const [first = "home", second] = pathname.split("/").filter(Boolean)
  return safeString([first, second].filter(Boolean).join(".") || "home")
}

function safeContextID(value: string | null | undefined) {
  if (!value) return undefined
  const cleaned = value.replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 96)
  return cleaned || undefined
}

function normalizePath(pathname: string) {
  return pathname
    .split("/")
    .map((part) => (part.length > 24 || /^[0-9a-f-]{12,}$/i.test(part) ? ":id" : part))
    .join("/")
}

function stripUrl(value: string) {
  try {
    const url = new URL(value, location.origin)
    return `${url.origin === location.origin ? "" : url.origin}${normalizePath(url.pathname)}`
  } catch {
    return safeString(value)
  }
}

function safeString(value: string) {
  return value.replace(/[?#].*$/, "").slice(0, MAX_LABEL_LENGTH)
}

function wrapHistoryNavigation(method: "pushState" | "replaceState", onNavigate: () => void) {
  const original = history[method]
  history[method] = function patchedHistoryNavigation(this: History, ...args: Parameters<History[typeof method]>) {
    const result = original.apply(this, args)
    onNavigate()
    return result
  }
  cleanup.push(() => {
    history[method] = original
  })
}

function tokenKey(part: { id: string; messageID?: string }) {
  return `${part.messageID ?? "message"}:${part.id}`
}

function browserNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") return performance.now()
  return Date.now()
}

function finiteDuration(value: number) {
  if (!Number.isFinite(value) || value < 0) return undefined
  return value
}

function contextLabels(input: BrowserTelemetryContext) {
  return {
    sessionID: input.sessionID ?? null,
    scopeID: input.scopeID ?? null,
    correlationId: input.correlationId ?? null,
    navigationId: input.navigationId ?? null,
    sessionSwitchId: input.sessionSwitchId ?? null,
  }
}

function rememberLongTask(entry: LongTaskEntry) {
  recentLongTasks.push(entry)
  const cutoff = entry.startTime - RECENT_LONG_TASK_WINDOW_MS
  while (recentLongTasks.length && recentLongTasks[0].startTime + recentLongTasks[0].duration < cutoff) {
    recentLongTasks.shift()
  }
}

function longTaskOverlap(startTime: number, endTime: number) {
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) return 0
  return recentLongTasks.reduce((total, task) => {
    const start = Math.max(startTime, task.startTime)
    const end = Math.min(endTime, task.startTime + task.duration)
    return end > start ? total + (end - start) : total
  }, 0)
}

function encodedSize(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

export function stopBrowserPerformanceMetrics() {
  if (timer) window.clearInterval(timer)
  for (const stop of cleanup.splice(0)) stop()
  timer = undefined
  queue = []
  locallyRejected = 0
  started = false
}
