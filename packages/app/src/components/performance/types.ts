import type {
  PerfDashboardSummary,
  PerfIssue,
  PerfTraceDetail,
  PerfTraceListItem,
  PerfTimeline,
  PerformanceAnalysisView,
} from "@ericsanchezok/synergy-sdk"

export type PerformanceMetricPoint = {
  timestamp?: number | string
  label?: string
  value?: number
  cpu?: number
  memory?: number
  serviceMemory?: number
  heapUsed?: number
  heapTotal?: number
  external?: number
  arrayBuffers?: number
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
export type PerformanceAnalysis = PerformanceAnalysisView

export type BrowserMetricSample = {
  timestamp: number
  memory?: number
  domNodes?: number
  navigationMs?: number
}
