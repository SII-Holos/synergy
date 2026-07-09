import type {
  PerfDashboardSummary,
  PerfIssue,
  PerfTraceDetail,
  PerfTraceListItem,
  PerfTimeline,
} from "@ericsanchezok/synergy-sdk"

export type PerformanceMetricPoint = {
  timestamp?: number | string
  label?: string
  value?: number
  cpu?: number
  memory?: number
  heapUsed?: number
  heapTotal?: number
  requests?: number
  latency?: number
  activeSessions?: number
  domNodes?: number
  diskReadOps?: number
  diskWriteOps?: number
  diskOps?: number
  readBytes?: number
  writeBytes?: number
  eventLoopLag?: number
}

export type PerformanceTraceSpan = PerfTraceListItem
export type PerformanceIssue = PerfIssue
export type PerformanceRankedItem = PerfDashboardSummary["top"]["slowRoutes"][number]
export type PerformanceSummary = Omit<PerfDashboardSummary, "resources" | "top"> & {
  quality?: PerformanceTimeline["quality"]
  resources: PerfDashboardSummary["resources"] & {
    appReadOps?: number
    appWriteOps?: number
  }
  top: PerfDashboardSummary["top"] & {
    slowLibrary?: PerformanceRankedItem[]
    childProcesses?: PerformanceRankedItem[]
    slowFrontend?: PerformanceRankedItem[]
  }
}
export type PerformanceTraceDetail = PerfTraceDetail
export type PerformanceTimeline = PerfTimeline

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
