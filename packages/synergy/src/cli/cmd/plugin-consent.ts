import type { ApprovalApproveBody, ApprovalReview } from "../../plugin/consent/approval-service"
import type { PluginPermissionDiff } from "../../plugin/consent/schema"
import type { PluginStatus } from "../../plugin/status"
import { UI } from "../ui"

function severityColor(severity: string): string {
  if (severity === "high") return UI.Style.TEXT_DANGER
  if (severity === "medium") return UI.Style.TEXT_WARNING
  return UI.Style.TEXT_DIM
}

function severityLabel(severity: string): string {
  return `${severityColor(severity)}${severity}${UI.Style.TEXT_NORMAL}`
}

export function formatPluginPermissionDiff(diff: PluginPermissionDiff): string[] {
  const lines = [
    "",
    `${UI.Style.TEXT_NORMAL_BOLD}Permission changes:${UI.Style.TEXT_NORMAL} ${diff.fromVersion ?? "none"} → ${diff.toVersion ?? "unknown"}`,
  ]

  if (diff.riskBefore || diff.riskAfter) {
    const before = diff.riskBefore ? severityLabel(diff.riskBefore) : "—"
    const after = diff.riskAfter ? severityLabel(diff.riskAfter) : "—"
    lines.push(`  ${UI.Style.TEXT_DIM}Risk:${UI.Style.TEXT_NORMAL} ${before} → ${after}`)
  }

  if (diff.added.length > 0) {
    lines.push(`  ${UI.Style.TEXT_DANGER}Added:${UI.Style.TEXT_NORMAL}`)
    for (const item of diff.added) {
      lines.push(
        `    ${severityLabel(item.severity)} ${item.title}${item.description ? ` — ${UI.Style.TEXT_DIM}${item.description}${UI.Style.TEXT_NORMAL}` : ""}`,
      )
    }
  }

  if (diff.removed.length > 0) {
    lines.push(`  ${UI.Style.TEXT_DIM}Removed:${UI.Style.TEXT_NORMAL}`)
    for (const item of diff.removed) lines.push(`    ${item.title}`)
  }

  if (diff.unchanged.length > 0) {
    lines.push(`  ${UI.Style.TEXT_SUCCESS}Unchanged:${UI.Style.TEXT_NORMAL}`)
    for (const item of diff.unchanged) lines.push(`    ${severityLabel(item.severity)} ${item.title}`)
  }

  if (diff.changed.length > 0) {
    lines.push(`  ${UI.Style.TEXT_INFO}Changed severity:${UI.Style.TEXT_NORMAL}`)
    for (const change of diff.changed) {
      lines.push(
        `    ${change.key}: ${severityLabel(change.before ?? "none")} → ${severityLabel(change.after ?? "none")}`,
      )
    }
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
  UI.println(
    `  ${UI.Style.TEXT_DIM}Risk:${UI.Style.TEXT_NORMAL} ${severityLabel(review.risk)}  ${UI.Style.TEXT_DIM}Trust:${UI.Style.TEXT_NORMAL} ${review.trust}`,
  )
  if (review.reason) UI.println(`  ${review.reason}`)
  printPluginPermissionDiff(review.diff)
}

export function approvalSubmitBody(review: ApprovalReview): ApprovalApproveBody {
  return { target: review.target, reviewToken: review.reviewToken }
}

export function pluginStatusText(status: PluginStatus): string {
  if (status.loaded) return "loaded"
  if (status.disabledPhase === "approval") return "needs approval"
  return status.disabledPhase ? `disabled (${status.disabledPhase})` : "disabled"
}

export function pluginInfoStateText(status: PluginStatus): string {
  return status.disabledPhase === "approval" ? "disabled (needs approval)" : pluginStatusText(status)
}
