import type { PerfDashboardSummary, PerfIssue, PerfTraceListItem } from "@ericsanchezok/synergy-sdk"

export type PerformanceMetricPoint = {
  timestamp?: number | string
  label?: string
  value?: number
  cpu?: number
  memory?: number
  requests?: number
  latency?: number
  activeSessions?: number
}

export type PerformanceTraceSpan = PerfTraceListItem
export type PerformanceIssue = PerfIssue
export type PerformanceSummary = PerfDashboardSummary

export type BrowserMetricSample = {
  timestamp: number
  memory?: number
  domNodes?: number
  navigationMs?: number
}

export type PerformanceEvent =
  | { type: "summary"; summary?: PerformanceSummary }
  | { type: "trace"; trace?: PerformanceTraceSpan }
  | { type: "issue"; issue?: PerformanceIssue }
  | { type: "browser"; sample?: BrowserMetricSample }
  | { type: "error"; message?: string }
