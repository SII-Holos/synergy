import type { MessageDescriptor } from "@lingui/core"
import type { PerformanceIssue } from "./types"

export function traceDisplayName(name: string, attributes?: Record<string, unknown>) {
  const method = attributes?.method ?? attributes?.["http.method"]
  const route = attributes?.route ?? attributes?.["http.route"] ?? attributes?.path
  return typeof method === "string" && typeof route === "string" ? `${method} ${route}` : name
}

export function issueTitle(issue: Pick<PerformanceIssue, "code" | "title">): string | MessageDescriptor {
  return ISSUE_TITLES[issue.code] ?? issue.title
}

const ISSUE_TITLES: Record<string, MessageDescriptor> = {
  PERF_HTTP_SLOW_REQUEST: { id: "app.performance.issue.slowRequest", message: "Slow HTTP request" },
  PERF_HTTP_ERROR: { id: "app.performance.issue.requestFailed", message: "HTTP request failed" },
  PERF_SESSION_SLOW_TURN: { id: "app.performance.issue.slowTurn", message: "Slow session turn" },
  PERF_LLM_SLOW_CALL: { id: "app.performance.issue.slowModel", message: "Slow model call" },
  PERF_TOOL_STALLED: { id: "app.performance.issue.slowTool", message: "Slow tool execution" },
  PERF_STORAGE_SLOW_OPERATION: { id: "app.performance.issue.slowStorage", message: "Slow storage operation" },
  PERF_STORAGE_OPERATION_ERROR: { id: "app.performance.issue.storageFailed", message: "Storage operation failed" },
  PERF_LIBRARY_SLOW_QUERY: { id: "app.performance.issue.slowLibrary", message: "Slow knowledge query" },
  PERF_FRONTEND_LONG_TASK: { id: "app.performance.issue.longTask", message: "Long browser task" },
  PERF_TRACE_SLOW: { id: "app.performance.issue.slowOperation", message: "Slow operation" },
  PERF_TOOL_EXECUTION_FAILED: { id: "app.performance.issue.toolFailed", message: "Tool execution failed" },
  PERF_MEMORY_HIGH_RSS: { id: "app.performance.issue.highRss", message: "High process memory usage" },
  PERF_MEMORY_HIGH_HEAP_RATIO: { id: "app.performance.issue.highHeap", message: "High heap usage" },
  PERF_MEMORY_HIGH_EXTERNAL: { id: "app.performance.issue.highExternal", message: "High external memory usage" },
  PERF_MEMORY_HIGH_ARRAY_BUFFERS: { id: "app.performance.issue.highBuffers", message: "High ArrayBuffer usage" },
  PERF_CPU_HIGH_UTILIZATION: { id: "app.performance.issue.highCpu", message: "High CPU utilization" },
  PERF_EVENT_LOOP_LAG: { id: "app.performance.issue.loopLag", message: "Event loop delay" },
  PERF_OBSERVABILITY_WRITER_BACKPRESSURE: {
    id: "app.performance.issue.backpressure",
    message: "Telemetry write queue is full",
  },
  PERF_OBSERVABILITY_WRITER_APPEND_FAILED: {
    id: "app.performance.issue.writeFailed",
    message: "Telemetry write failed",
  },
}

export const ISSUE_SEVERITY: Record<PerformanceIssue["severity"], MessageDescriptor> = {
  info: { id: "app.performance.severity.info", message: "Information" },
  warning: { id: "app.performance.severity.warning", message: "Warning" },
  error: { id: "app.performance.severity.error", message: "Error" },
  critical: { id: "app.performance.severity.critical", message: "Critical" },
}
