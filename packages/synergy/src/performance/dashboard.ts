import { Diagnostics } from "../observability/diagnostics"
import { PerformanceMetrics } from "./metrics"
import { PerformanceIssues } from "./issues"
import { PerformanceSchema } from "./schema"
import { PerformanceStore } from "./store"

export namespace PerformanceDashboard {
  type MetricRow = PerformanceStore.StoredMetric & { labels: Record<string, unknown> }

  export async function summary(
    input: { windowMs?: number; scopeID?: string } = {},
  ): Promise<PerformanceSchema.DashboardSummary> {
    const windowMs = Math.max(1000, Math.min(input.windowMs ?? 300_000, 86_400_000))
    const since = Date.now() - windowMs
    const rows = PerformanceStore.queryMetrics({ since, scopeID: input.scopeID, limit: 50_001, newestFirst: true })
    const truncated = rows.length > 50_000
    const metrics = (truncated ? rows.slice(-50_000) : rows).map((row) => ({
      ...row,
      labels: parseLabels(row.labels_json),
    }))
    const resources = PerformanceStore.latestResource({ scopeID: input.scopeID })
    const issues = PerformanceIssues.list({ status: "open", scopeID: input.scopeID, limit: 20 })
    const diagnostics = await Diagnostics.summary().catch(() => undefined)
    const http = metrics.filter((row) => row.name === "http.request.duration")
    const httpDurations = http.map((row) => row.value)
    const httpErrors = http.filter((row) => row.labels.status && Number(row.labels.status) >= 500).length
    const turns = metrics.filter((row) => row.name === "session.turn.duration")
    const llm = metrics.filter((row) => row.module === "llm" && row.name.endsWith(".duration"))
    const tools = metrics.filter((row) => row.name === "tool.execution.duration")
    const storage = metrics.filter((row) => row.name === "storage.operation.duration")
    const library = metrics.filter((row) => row.name === "library.operation.duration")
    const frontendResources = metrics.filter((row) => row.name === "frontend.resource.duration")
    const frontendLongTasks = metrics.filter((row) => row.name === "frontend.long_task.duration")
    const frontendVital = (name: string) =>
      last(metrics.filter((row) => row.name === "frontend.web_vital" && row.labels.name === name))?.value
    const criticalIssueCount = issues.filter((issue) => issue.severity === "critical").length
    const score = Math.max(
      0,
      100 -
        criticalIssueCount * 40 -
        issues.filter((issue) => issue.severity === "error").length * 20 -
        issues.filter((issue) => issue.severity === "warning").length * 8,
    )
    const status = criticalIssueCount > 0 ? "critical" : issues.length > 0 ? "degraded" : "healthy"
    return PerformanceSchema.DashboardSummary.parse({
      generatedAt: new Date().toISOString(),
      windowMs,
      quality: truncated ? { truncated: true, partial: true } : undefined,
      health: { status, score, openIssueCount: issues.length, criticalIssueCount },
      backend: {
        requestCount: http.length,
        errorRate: http.length ? httpErrors / http.length : 0,
        p50RequestMs: PerformanceMetrics.percentile(httpDurations, 50),
        p95RequestMs: PerformanceMetrics.percentile(httpDurations, 95),
        p99RequestMs: PerformanceMetrics.percentile(httpDurations, 99),
        activeSessions: activeSessionCount(metrics),
        pendingSessions: diagnostics?.sessions.pendingReply.length ?? 0,
      },
      resources: {
        rssBytes: resources?.memory_rss_bytes ?? undefined,
        heapUsedBytes: resources?.memory_heap_used_bytes ?? undefined,
        heapTotalBytes: resources?.memory_heap_total_bytes ?? undefined,
        cpuUtilizationRatio: resources?.cpu_utilization_ratio ?? undefined,
        eventLoopLagP95Ms: PerformanceMetrics.percentile(
          PerformanceStore.resourceSince(since, { scopeID: input.scopeID }).map((row) => row.event_loop_lag_ms ?? 0),
          95,
        ),
        appReadBytes: resources?.app_read_bytes ?? undefined,
        appWrittenBytes: resources?.app_written_bytes ?? undefined,
        appReadOps: resources?.app_read_ops ?? undefined,
        appWriteOps: resources?.app_write_ops ?? undefined,
      },
      sessions: {
        turnCount: turns.length,
        p95TurnMs: PerformanceMetrics.percentile(
          turns.map((row) => row.value),
          95,
        ),
        llmCallCount: llm.length,
        toolCallCount: tools.length,
      },
      frontend: {
        inpMs: frontendVital("INP"),
        lcpMs: frontendVital("LCP"),
        cls: frontendVital("CLS"),
        fcpMs: frontendVital("FCP"),
        ttfbMs: frontendVital("TTFB"),
        longTaskCount: frontendLongTasks.length,
        resourceP95Ms: PerformanceMetrics.percentile(
          frontendResources.map((row) => row.value),
          95,
        ),
      },
      runtime: {
        alive: diagnostics?.lock?.inspection?.alive,
        healthy: diagnostics?.lock?.inspection?.healthy,
        pid: diagnostics?.lock?.lock?.pid,
        mode: diagnostics?.lock?.lock?.mode,
        traceFiles: diagnostics?.traces.files.length ?? 0,
        recentErrors: diagnostics?.traces.recentErrors.length ?? 0,
        pendingSessions: diagnostics?.sessions.pendingReply.length ?? 0,
      },
      top: {
        slowRoutes: rank(http, "path"),
        slowSessions: rank(turns, "session_id"),
        slowTools: rank(tools, "tool"),
        slowProviders: rank(llm, "providerID", "provider", "modelID", "model"),
        slowStorage: rank(storage, "operation"),
        slowLibrary: rank(library, "operation"),
        slowFrontend: rank(
          [...frontendResources, ...frontendLongTasks],
          "routeName",
          "pathTemplate",
          "route",
          "name",
          "attribution",
        ),
      },
      issues,
    })
  }

  function rank(rows: MetricRow[], ...labelKeys: string[]): PerformanceSchema.RankedItem[] {
    return [...rows]
      .sort((a, b) => b.value - a.value)
      .slice(0, 5)
      .map((row, index) => {
        const label = String(firstLabel(row.labels, labelKeys) ?? row.tool ?? row.session_id ?? row.name)
        return {
          id: `${row.metric_id}-${index}`,
          label,
          module: row.module,
          value: row.value,
          unit: row.unit,
          traceId: row.trace_id ?? undefined,
          sessionID: row.session_id ?? undefined,
          tool: row.tool ?? undefined,
        }
      })
  }

  function firstLabel(labels: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = labels[key]
      if (value !== undefined && value !== null && value !== "") return value
    }
  }

  function activeSessionCount(rows: MetricRow[]) {
    const active = new Set<string>()
    const recentCutoff = Date.now() - 5 * 60_000
    for (const row of rows) {
      if (!row.session_id || row.time < recentCutoff) continue
      active.add(row.session_id)
    }
    return active.size
  }

  function parseLabels(text: string) {
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  function last<T>(items: T[]) {
    return items[items.length - 1]
  }
}
