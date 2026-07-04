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

type QueueEntry =
  | { kind: "metric"; value: BrowserMetric }
  | { kind: "resource"; value: ResourceEntry }
  | { kind: "longTask"; value: LongTaskEntry }

const MAX_BATCH = 100
const MAX_PAYLOAD_BYTES = 256 * 1024
const FLUSH_INTERVAL_MS = 10_000
const MAX_LABEL_LENGTH = 160

let started = false
let timer: number | undefined
let queue: QueueEntry[] = []
let locallyRejected = 0
let cleanup: Array<() => void> = []
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
  window.addEventListener("visibilitychange", onVisibilityChange)
  window.addEventListener("pagehide", flush)
  cleanup.push(() => window.removeEventListener("visibilitychange", onVisibilityChange))
  cleanup.push(() => window.removeEventListener("pagehide", flush))
}

function enqueue(entry: QueueEntry) {
  if (queue.length >= MAX_BATCH * 4) {
    locallyRejected++
    return
  }
  queue.push(entry)
}

async function flushBrowserMetrics(input: { url: string; client: SynergyClient }) {
  if (queue.length === 0 && locallyRejected === 0) return
  const entries = queue.splice(0, MAX_BATCH)
  const metrics = entries.flatMap((entry) => (entry.kind === "metric" ? [entry.value] : []))
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
    locallyRejected += entries.length
    return
  }
  try {
    await input.client.performance.browserMetrics.ingest({ perfBrowserMetricBatch: body }, { throwOnError: true })
    locallyRejected = 0
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
    enqueue({
      kind: "longTask",
      value: { startTime: entry.startTime, duration: entry.duration, attribution: "longtask" },
    })
  })
  observe("long-animation-frame", (entry) => {
    enqueue({
      kind: "longTask",
      value: { startTime: entry.startTime, duration: entry.duration, attribution: "long-animation-frame" },
    })
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

function pageContext(): PerfBrowserMetricBatch["page"] {
  return {
    pathTemplate: normalizePath(location.pathname),
  }
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

function encodedSize(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

export function stopBrowserPerformanceMetrics() {
  if (timer) window.clearInterval(timer)
  for (const stop of cleanup.splice(0)) stop()
  timer = undefined
  queue = []
  started = false
}
