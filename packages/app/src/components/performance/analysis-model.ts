import type { SessionScope } from "@ericsanchezok/synergy-sdk"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { HOME_SCOPE_KEY } from "@/utils/scope"
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

export function performanceAnalysisSessionPath(input: {
  sessionID: string
  scope: Pick<SessionScope, "type" | "directory">
}) {
  const scopeKey = input.scope.type === "home" ? HOME_SCOPE_KEY : input.scope.directory
  if (!scopeKey) return
  return `/${base64Encode(scopeKey)}/session/${input.sessionID}`
}
