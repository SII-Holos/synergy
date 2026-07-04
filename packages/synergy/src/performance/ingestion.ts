import { PerformanceClock } from "./clock"
import { PerformanceMetrics } from "./metrics"
import { PerformanceRedaction } from "./redact"
import { PerformanceSchema } from "./schema"
import { PerformanceStore } from "./store"

export namespace PerformanceIngestion {
  export function browserMetrics(
    input: PerformanceSchema.BrowserMetricBatch,
  ): PerformanceSchema.BrowserMetricIngestResult {
    const receivedTime = PerformanceClock.now()
    const batchId = input.batchId ?? PerformanceClock.id("brb")
    let accepted = 0
    let rejected = 0
    const page = normalizePage(input.page)
    for (const metric of input.metrics) {
      if (!isAllowedBrowserMetric(metric.name)) {
        rejected++
        continue
      }
      try {
        PerformanceMetrics.record({
          name: metric.name,
          value: metric.value,
          unit: metric.unit,
          module: "frontend",
          source: "browser",
          labels: browserLabels(metric.labels),
          sessionID: page.sessionID,
          scopeID: page.scopeID,
        })
        accepted++
      } catch {
        rejected++
      }
    }
    for (const entry of input.resourceEntries ?? []) {
      if (!entry.name.startsWith("http") && !entry.name.startsWith("/")) {
        rejected++
        continue
      }
      PerformanceMetrics.record({
        name: "frontend.resource.duration",
        value: entry.duration,
        unit: "ms",
        module: "frontend",
        source: "browser",
        labels: {
          name: PerformanceRedaction.url(entry.name),
          initiatorType: entry.initiatorType,
          transferSize: entry.transferSize ?? 0,
        },
        sessionID: page.sessionID,
        scopeID: page.scopeID,
      })
      accepted++
    }
    for (const task of input.longTasks ?? []) {
      PerformanceMetrics.record({
        name: "frontend.long_task.duration",
        value: task.duration,
        unit: "ms",
        module: "frontend",
        source: "browser",
        labels: { attribution: task.attribution ?? "unknown" },
        sessionID: page.sessionID,
        scopeID: page.scopeID,
      })
      accepted++
    }
    PerformanceStore.insertBrowserBatch({
      batchId,
      receivedTime,
      sentAt: input.sentAt,
      accepted,
      rejected,
      page,
    })
    return { batchId, accepted, rejected, receivedAt: PerformanceClock.iso(receivedTime) }
  }

  function isAllowedBrowserMetric(name: string) {
    return name.startsWith("frontend.") || name.startsWith("web_vital.") || name.startsWith("browser.")
  }

  function normalizePage(page: PerformanceSchema.BrowserMetricBatch["page"]) {
    const pathTemplate = page.pathTemplate ?? page.routeName
    return {
      pathTemplate: pathTemplate ? PerformanceRedaction.routePath(pathTemplate) : undefined,
      sessionID: page.sessionID || undefined,
      scopeID: page.scopeID || undefined,
    }
  }

  function browserLabels(labels: Record<string, unknown> | undefined) {
    const clean: Record<string, string | number | boolean | null> = {}
    for (const [key, value] of Object.entries(labels ?? {}).slice(0, 12)) {
      if (!isAllowedBrowserLabel(key)) continue
      const safeKey = key.slice(0, 48)
      if (typeof value === "string") {
        clean[safeKey] = looksLikeUrlKey(key)
          ? PerformanceRedaction.routePath(value)
          : PerformanceRedaction.text(value, 160)
        continue
      }
      if (typeof value === "number" || typeof value === "boolean" || value === null) clean[safeKey] = value
    }
    return clean
  }

  function isAllowedBrowserLabel(key: string) {
    const normalized = key.toLowerCase()
    if (
      /(prompt|completion|content|body|header|token|secret|password|cookie|env|sql|output|terminal|message)/.test(
        normalized,
      )
    )
      return false
    return /^(name|rating|attribution|route|path|initiator|size|duration|value|type|component)$/.test(normalized)
  }

  function looksLikeUrlKey(key: string) {
    return /(url|path|route)/i.test(key)
  }
}
