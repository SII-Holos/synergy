import type { ApprovalApproveBody, ApprovalReview } from "../../plugin/consent/approval-service"
import type { PluginPermissionDiff } from "../../plugin/consent/schema"
import type { PluginStatus } from "../../plugin/status"
import { UI } from "../../util/ui"

function formatAccessItem(item: PluginPermissionDiff["access"][number]): string {
  return `${item.title}${item.description ? ` — ${UI.Style.TEXT_DIM}${item.description}${UI.Style.TEXT_NORMAL}` : ""}`
}

export function formatPluginPermissionDiff(diff: PluginPermissionDiff): string[] {
  const lines = [
    "",
    `${UI.Style.TEXT_NORMAL_BOLD}Access changes:${UI.Style.TEXT_NORMAL} ${diff.fromVersion ?? "none"} → ${diff.toVersion ?? "unknown"}`,
  ]
  if (diff.added.length > 0) {
    lines.push(`  ${UI.Style.TEXT_WARNING}Added:${UI.Style.TEXT_NORMAL}`)
    for (const item of diff.added) lines.push(`    ${formatAccessItem(item)}`)
  }
  if (diff.broadened.length > 0) {
    lines.push(`  ${UI.Style.TEXT_WARNING}Expanded:${UI.Style.TEXT_NORMAL}`)
    for (const item of diff.broadened) lines.push(`    ${formatAccessItem(item)}`)
  }
  if (diff.removed.length > 0) {
    lines.push(`  ${UI.Style.TEXT_DIM}Removed:${UI.Style.TEXT_NORMAL}`)
    for (const item of diff.removed) lines.push(`    ${item.title}`)
  }
  if (diff.added.length === 0 && diff.broadened.length === 0 && diff.removed.length === 0) {
    lines.push(`  ${UI.Style.TEXT_SUCCESS}No access expansion.${UI.Style.TEXT_NORMAL}`)
  }
  lines.push("")
  return lines
}

export function printPluginPermissionDiff(diff: PluginPermissionDiff): void {
  for (const line of formatPluginPermissionDiff(diff)) UI.println(line)
}

export function printApprovalReview(review: ApprovalReview): void {
  UI.println(
    `${UI.Style.TEXT_NORMAL_BOLD}${review.name}${UI.Style.TEXT_NORMAL} ${UI.Style.TEXT_DIM}v${review.version}${UI.Style.TEXT_NORMAL}`,
  )
  UI.println(`  ${UI.Style.TEXT_DIM}Source:${UI.Style.TEXT_NORMAL} ${review.source}`)
  if (review.reason) UI.println(`  ${review.reason}`)
  UI.println(`  ${UI.Style.TEXT_NORMAL_BOLD}This plugin can:${UI.Style.TEXT_NORMAL}`)
  if (review.access.length === 0) UI.println(`    ${UI.Style.TEXT_DIM}No host access requested.${UI.Style.TEXT_NORMAL}`)
  for (const item of review.access) UI.println(`    ${formatAccessItem(item)}`)
  UI.println("")
}

export function approvalSubmitBody(review: ApprovalReview): ApprovalApproveBody {
  return { target: review.target, reviewToken: review.reviewToken }
}

export function pluginStatusText(status: PluginStatus): string {
  if (status.loaded) return "loaded"
  if (status.disabledPhase === "approval") return "needs confirmation"
  return status.disabledPhase ? `disabled (${status.disabledPhase})` : "disabled"
}

export function pluginInfoStateText(status: PluginStatus): string {
  return status.disabledPhase === "approval" ? "disabled (needs confirmation)" : pluginStatusText(status)
}
