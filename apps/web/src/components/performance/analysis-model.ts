import type { MessageDescriptor } from "@lingui/core"
import type { SessionScope } from "@ericsanchezok/synergy-sdk"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { HOME_SCOPE_KEY } from "@/utils/scope"
import type { PerformanceAnalysis } from "./types"
import { P } from "./performance-i18n"

export function isPerformanceAnalysisActive(status: PerformanceAnalysis["status"] | undefined) {
  return status === "queued" || status === "running"
}

export function performanceAnalysisStatusDescriptor(status: PerformanceAnalysis["status"]): MessageDescriptor {
  switch (status) {
    case "queued":
      return P.analysisStatusQueued
    case "running":
      return P.analysisStatusRunning
    case "completed":
      return P.analysisStatusCompleted
    case "error":
      return P.analysisStatusFailed
    case "cancelled":
      return P.analysisStatusCancelled
    case "interrupted":
      return P.analysisStatusInterrupted
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
