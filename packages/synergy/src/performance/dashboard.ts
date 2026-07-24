import { Cortex } from "@/cortex"
import { Diagnostics } from "@/observability/diagnostics"
import { ObservabilityIssues } from "@/observability/issues"
import { ObservabilityMetrics } from "@/observability/metrics"
import { ObservabilityStore } from "@/observability/store"
import { SessionManager } from "@/session/manager"
import { SessionMessageCache } from "@/session/message-cache"
import { LLMTurnMemory } from "@/session/llm-memory"
import { parseJson } from "@/util/json-parse"
import { PerformanceProjection } from "./projection"
import { PerformanceSchema } from "./schema"
import { AgentTurn } from "@/session/agent-turn"
import { ToolScheduler } from "@/session/tool-scheduler"
import { PolicyWorker } from "@/enforcement/policy-worker"

export namespace PerformanceDashboard {
  type MetricRow = ObservabilityStore.StoredMetric & { labels: Record<string, unknown> }

  export async function summary(
    input: { windowMs?: number; scopeID?: string } = {},
  ): Promise<PerformanceSchema.DashboardSummary> {
    const windowMs = Math.max(1000, Math.min(input.windowMs ?? 300_000, 86_400_000))
    const since = Date.now() - windowMs
    const rows = ObservabilityStore.queryMetrics({ since, scopeID: input.scopeID, limit: 50_001, newestFirst: true })
    const truncated = rows.length > 50_000
    const metrics = (truncated ? rows.slice(0, 50_000) : rows).map((row) => ({
      ...row,
      labels: parseJson(row.labels_json),
    }))
    const resourceRows = ObservabilityStore.resourceSince(since, { scopeID: input.scopeID })
    const serverResourceRows = resourceRows.filter((row) => row.process_role === "server")
    const resources = serverResourceRows.at(-1)
    const currentChildRows = resources
      ? resourceRows.filter((row) => row.time === resources.time && row.process_role?.startsWith("tool"))
      : []
    const childProcesses = rankChildProcesses(currentChildRows)
    const issueCounts = ObservabilityStore.countIssues({ status: "open", scopeID: input.scopeID, since })
    const issues = ObservabilityIssues.list({
      status: "open",
      scopeID: input.scopeID,
      since,
      limit: 20,
    }).map(PerformanceProjection.issue)
    const diagnostics = await Diagnostics.summary().catch(() => undefined)
    const runtimeStats = SessionManager.runtimeStats()
    const agentWorkers = AgentTurn.stats()
    const policyWorkers = PolicyWorker.stats()
    const toolTasks = ToolScheduler.stats()
    const messageCacheStats = SessionMessageCache.stats()
    const llmTurnStats = LLMTurnMemory.stats()
    const activeLLMTurns = LLMTurnMemory.activeSnapshot(20)
    const cortexTasks = Cortex.list()
    const cortexStats = {
      totalCount: cortexTasks.length,
      byStatus: {
        queued: cortexTasks.filter((task) => task.status === "queued").length,
        running: cortexTasks.filter((task) => task.status === "running").length,
        completed: cortexTasks.filter((task) => task.status === "completed").length,
        error: cortexTasks.filter((task) => task.status === "error").length,
        cancelled: cortexTasks.filter((task) => task.status === "cancelled").length,
        interrupted: cortexTasks.filter((task) => task.status === "interrupted").length,
      },
      retainedPromptChars: cortexTasks.reduce((sum, task) => sum + task.prompt.length, 0),
      retainedOutputChars: cortexTasks.reduce((sum, task) => {
        if (!task.output) return sum
        if (task.output.mode === "summary" || task.output.mode === "final_response")
          return sum + task.output.value.length
        try {
          return sum + JSON.stringify(task.output.value).length
        } catch {
          return sum
        }
      }, 0),
      retainedErrorChars: cortexTasks.reduce((sum, task) => sum + (task.error?.length ?? 0), 0),
      retainedProgressToolCount: cortexTasks.reduce((sum, task) => sum + (task.progress?.recentTools?.length ?? 0), 0),
    }
    const http = metrics.filter((row) => row.name === "http.request.duration")
    const httpDurations = http.map((row) => row.value)
    const httpErrors = http.filter((row) => row.labels.status && Number(row.labels.status) >= 500).length
    const turns = metrics.filter((row) => row.name === "session.turn.duration")
    const llm = metrics.filter((row) => row.module === "llm" && row.name.endsWith(".duration"))
    const tools = metrics.filter((row) => row.name === "tool.execution.duration")
    const toolFailures = rankToolFailures(metrics)
    const storage = metrics.filter((row) => row.name === "storage.operation.duration")
    const library = metrics.filter((row) => row.name === "library.operation.duration")
    const frontendResources = metrics.filter((row) => row.name === "frontend.resource.duration")
    const frontendLongTasks = metrics.filter((row) => row.name === "frontend.long_task.duration")
    const frontendVital = (name: string) =>
      metrics.find((row) => row.name === "frontend.web_vital" && row.labels.name === name)?.value
    const criticalIssueCount = issueCounts.critical
    const score = Math.max(0, 100 - criticalIssueCount * 40 - issueCounts.error * 20 - issueCounts.warning * 8)
    const status = criticalIssueCount > 0 ? "critical" : issueCounts.total > 0 ? "degraded" : "healthy"
    return PerformanceSchema.DashboardSummary.parse({
      generatedAt: new Date().toISOString(),
      windowMs,
      quality: truncated
        ? {
            truncated: true,
            partial: true,
            unavailableReason: "Dashboard summary reached the protected row cap for this window.",
          }
        : undefined,
      health: { status, score, openIssueCount: issueCounts.total, criticalIssueCount },
      backend: {
        requestCount: http.length,
        errorRate: http.length ? httpErrors / http.length : 0,
        p50RequestMs: ObservabilityMetrics.percentile(httpDurations, 50),
        p95RequestMs: ObservabilityMetrics.percentile(httpDurations, 95),
        p99RequestMs: ObservabilityMetrics.percentile(httpDurations, 99),
        activeSessions: activeSessionCount(metrics),
        pendingSessions: diagnostics?.sessions.pendingReply.length ?? 0,
      },
      resources: {
        rssBytes: resources?.memory_rss_bytes ?? undefined,
        heapUsedBytes: resources?.memory_heap_used_bytes ?? undefined,
        heapTotalBytes: resources?.memory_heap_total_bytes ?? undefined,
        externalBytes: resources?.memory_external_bytes ?? undefined,
        arrayBuffersBytes: resources?.memory_array_buffers_bytes ?? undefined,
        cpuUtilizationRatio: resources?.cpu_utilization_ratio ?? undefined,
        eventLoopLagP95Ms: ObservabilityMetrics.percentile(
          serverResourceRows.map((row) => row.event_loop_lag_ms ?? 0),
          95,
        ),
        appReadBytes: resources?.app_read_bytes ?? undefined,
        appWrittenBytes: resources?.app_written_bytes ?? undefined,
        appReadOps: resources?.app_read_ops ?? undefined,
        appWriteOps: resources?.app_write_ops ?? undefined,
        childProcessCount: currentChildRows.length,
        measuredChildProcessCount: currentChildRows.filter(
          (row) => row.memory_rss_bytes !== undefined && row.memory_rss_bytes !== null,
        ).length,
        serviceMemory:
          resources?.service_memory_source && resources.service_memory_completeness
            ? {
                rssBytes: resources.service_memory_rss_bytes ?? undefined,
                source: resources.service_memory_source,
                completeness: resources.service_memory_completeness,
              }
            : undefined,
        childProcessRssBytes: currentChildRows.reduce((sum, row) => sum + (row.memory_rss_bytes ?? 0), 0),
      },
      sessions: {
        turnCount: turns.length,
        p95TurnMs: ObservabilityMetrics.percentile(
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
        resourceP95Ms: ObservabilityMetrics.percentile(
          frontendResources.map((row) => row.value),
          95,
        ),
      },
      runtime: {
        alive:
          diagnostics?.lock?.inspection && typeof diagnostics.lock.inspection === "object"
            ? (diagnostics.lock.inspection as { alive?: boolean }).alive
            : undefined,
        healthy:
          diagnostics?.lock?.inspection && typeof diagnostics.lock.inspection === "object"
            ? (diagnostics.lock.inspection as { healthy?: boolean }).healthy
            : undefined,
        pid:
          diagnostics?.lock?.lock && typeof diagnostics.lock.lock === "object"
            ? (diagnostics.lock.lock as { pid?: number }).pid
            : undefined,
        mode:
          diagnostics?.lock?.lock && typeof diagnostics.lock.lock === "object"
            ? (diagnostics.lock.lock as { mode?: string }).mode
            : undefined,
        mirrorFiles: diagnostics?.traces.files.length ?? 0,
        traceFiles: diagnostics?.traces.files.length ?? 0,
        recentErrors: diagnostics?.traces.recentErrors.length ?? 0,
        pendingSessions: diagnostics?.sessions.pendingReply.length ?? 0,
        sessionRuntimes: runtimeStats,
        execution: {
          agentWorkers,
          policyWorkers,
          toolTasks,
        },
        messageCache: {
          totalBytes: messageCacheStats.totalBytes,
          activeCount: messageCacheStats.activeCount,
          entryCount: messageCacheStats.entryCount,
          hits: messageCacheStats.hits,
          misses: messageCacheStats.misses,
          evictions: messageCacheStats.evictions,
          protectedOverbudget: messageCacheStats.protectedOverbudget,
          entries: messageCacheStats.entries.map((entry) => ({ estimatedBytes: entry.estimatedBytes })),
          truncatedEntryCount: messageCacheStats.truncatedEntryCount,
        },
        llmTurns: {
          ...llmTurnStats,
          turns: activeLLMTurns.map((turn) => ({
            ageMs: turn.ageMs,
            streamActive: turn.streamActive,
            providerID: turn.providerID,
            modelID: turn.modelID,
            historyBeforeBytes: turn.historyBeforeBytes,
            historyAfterBytes: turn.historyAfterBytes,
            requestBytes: turn.requestBytes,
            toolSchemaBytes: turn.toolSchemaBytes,
            outputChars: turn.outputChars,
            toolRawChars: turn.toolRawChars,
          })),
        },
        cortexTasks: {
          totalCount: cortexStats.totalCount,
          queuedCount: cortexStats.byStatus.queued,
          runningCount: cortexStats.byStatus.running,
          completedCount: cortexStats.byStatus.completed,
          errorCount: cortexStats.byStatus.error,
          cancelledCount: cortexStats.byStatus.cancelled,
          interruptedCount: cortexStats.byStatus.interrupted,
          retainedPromptChars: cortexStats.retainedPromptChars,
          retainedOutputChars: cortexStats.retainedOutputChars,
          retainedErrorChars: cortexStats.retainedErrorChars,
          retainedProgressToolCount: cortexStats.retainedProgressToolCount,
        },
      },
      top: {
        slowRoutes: rank(http, "path"),
        slowSessions: rank(turns, "session_id"),
        slowTools: rank(tools, "tool"),
        toolFailures,
        slowProviders: rank(llm, "providerID", "provider", "modelID", "model"),
        slowStorage: rank(storage, "operation"),
        slowLibrary: rank(library, "operation"),
        childProcesses,
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
          module: row.module as PerformanceSchema.Module,
          value: row.value,
          unit: row.unit as PerformanceSchema.Unit,
          traceId: row.trace_id ?? undefined,
          sessionID: row.session_id ?? undefined,
          tool: row.tool ?? undefined,
        }
      })
  }

  function rankToolFailures(rows: MetricRow[]): PerformanceSchema.ToolFailureItem[] {
    const tools = new Map<string, { callCount: number; errorCount: number; categories: Map<string, number> }>()
    for (const row of rows) {
      if (row.name !== "tool.execution.count" && row.name !== "tool.execution.error") continue
      const tool = row.tool ?? stringLabel(row.labels.tool)
      if (!tool) continue
      const entry = tools.get(tool) ?? { callCount: 0, errorCount: 0, categories: new Map<string, number>() }
      if (row.name === "tool.execution.count") {
        entry.callCount += row.value
      } else {
        entry.errorCount += row.value
        const errorClass = stringLabel(row.labels.errorName) ?? "UnknownError"
        entry.categories.set(errorClass, (entry.categories.get(errorClass) ?? 0) + row.value)
      }
      tools.set(tool, entry)
    }
    return Array.from(tools, ([tool, entry]) => ({
      tool,
      callCount: entry.callCount,
      errorCount: entry.errorCount,
      errorRate: entry.errorCount / Math.max(entry.callCount, entry.errorCount, 1),
      categories: Array.from(entry.categories, ([errorClass, count]) => ({ errorClass, count }))
        .sort((a, b) => b.count - a.count || a.errorClass.localeCompare(b.errorClass))
        .slice(0, 3),
    }))
      .filter((entry) => entry.errorCount > 0)
      .sort((a, b) => b.errorCount - a.errorCount || b.errorRate - a.errorRate || a.tool.localeCompare(b.tool))
      .slice(0, 5)
  }

  function stringLabel(value: unknown) {
    return typeof value === "string" && value.length > 0 ? value : undefined
  }

  function rankChildProcesses(rows: ObservabilityStore.StoredResource[]): PerformanceSchema.RankedItem[] {
    const latest = new Map<string, ObservabilityStore.StoredResource>()
    for (const row of rows) {
      if (!row.process_role?.startsWith("tool")) continue
      if (row.memory_rss_bytes === undefined || row.memory_rss_bytes === null) continue
      const id = row.process_id ?? (row.pid === undefined || row.pid === null ? undefined : `pid:${row.pid}`)
      if (!id) continue
      const existing = latest.get(id)
      if (!existing || row.time > existing.time) latest.set(id, row)
    }
    return Array.from(latest.values())
      .sort((a, b) => (b.memory_rss_bytes ?? 0) - (a.memory_rss_bytes ?? 0))
      .slice(0, 5)
      .map((row, index) => {
        const labels = parseJson(row.labels_json)
        return {
          id: `${row.sample_id}-${index}`,
          label: String(labels.command ?? labels.description ?? row.process_id ?? row.pid ?? "tool child process"),
          module: "process" as const,
          value: row.memory_rss_bytes ?? 0,
          unit: "bytes" as const,
          processId: row.process_id ?? undefined,
          pid: row.pid ?? undefined,
          status: row.process_role ?? undefined,
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
}
