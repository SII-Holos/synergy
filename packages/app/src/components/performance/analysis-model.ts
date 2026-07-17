import type { PerformanceAnalysis } from "./types"

export function isPerformanceAnalysisActive(status: PerformanceAnalysis["status"] | undefined) {
  return status === "queued" || status === "running"
}

export function performanceAnalysisStatusLabel(status: PerformanceAnalysis["status"]) {
  switch (status) {
    case "queued":
      return "Queued"
    case "running":
      return "Running"
    case "completed":
      return "Completed"
    case "error":
      return "Failed"
    case "cancelled":
      return "Cancelled"
    case "interrupted":
      return "Interrupted"
  }
}
