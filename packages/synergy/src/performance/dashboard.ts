import { Diagnostics } from "../observability/diagnostics"
import { PerformanceMetrics } from "./metrics"
import { PerformanceIssues } from "./issues"
import { PerformanceSchema } from "./schema"
import { PerformanceStore } from "./store"

export namespace PerformanceDashboard {
  export async function summary(
    input: { windowMs?: number; scopeID?: string } = {},
  ): Promise<PerformanceSchema.DashboardSummary> {
    const windowMs = Math.max(1000, Math.min(input.windowMs ?? 300_000, 86_400_000))
    const since = Date.now() - windowMs
    const metrics = PerformanceStore.queryMetrics({ since, scopeID: input.scopeID, limit: 50_000 })
    const resources = PerformanceStore.latestResource({ scopeID: input.scopeID })
    const issues = PerformanceIssues.list({ status: "open", scopeID: input.scopeID, limit: 20 })
    const diagnostics = await Diagnostics.summary().catch(() => undefined)
    const http = metrics.filter((row) => row.name === "http.request.duration")
    const httpDurations = http.map((row) => row.value)
    const httpErrors = http.filter(
      (row) => parseLabels(row.labels_json).status && Number(parseLabels(row.labels_json).status) >= 500,
    ).length
    const turns = metrics.filter((row) => row.name === "session.turn.duration")
    const llm = metrics.filter((row) => row.name === "llm.request.duration" || row.name === "session.llm_call.duration")
    const tools = metrics.filter(
      (row) => row.name === "tool.execution.duration" || row.name === "session.tool_call.duration",
    )
    const frontendVital = (name: string) =>
      last(metrics.filter((row) => row.name === "frontend.web_vital" && parseLabels(row.labels_json).name === name))
        ?.value
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
      health: { status, score, openIssueCount: issues.length, criticalIssueCount },
      backend: {
        requestCount: http.length,
        errorRate: http.length ? httpErrors / http.length : 0,
        p50RequestMs: PerformanceMetrics.percentile(httpDurations, 50),
        p95RequestMs: PerformanceMetrics.percentile(httpDurations, 95),
        p99RequestMs: PerformanceMetrics.percentile(httpDurations, 99),
        activeSessions: 0,
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
        longTaskCount: metrics.filter((row) => row.name === "frontend.long_task.duration").length,
        resourceP95Ms: PerformanceMetrics.percentile(
          metrics.filter((row) => row.name === "frontend.resource.duration").map((row) => row.value),
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
        slowProviders: rank(llm, "provider"),
        slowStorage: rank(
          metrics.filter((row) => row.name === "storage.operation.duration"),
          "operation",
        ),
      },
      issues,
    })
  }

  function rank(rows: PerformanceStore.StoredMetric[], labelKey: string): PerformanceSchema.RankedItem[] {
    return [...rows]
      .sort((a, b) => b.value - a.value)
      .slice(0, 5)
      .map((row, index) => {
        const labels = parseLabels(row.labels_json)
        const label = String(labels[labelKey] ?? row.tool ?? row.session_id ?? row.name)
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
