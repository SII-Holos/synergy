import type { I18n, MessageDescriptor } from "@lingui/core"

type ApprovalStatus =
  | "not_required"
  | "pending_user"
  | "user_allowed"
  | "user_denied"
  | "auto_allowed"
  | "auto_denied"
  | "policy_denied"
  | "sandbox_blocked"
  | "pre_authorized"
type RiskLevel = "low" | "medium" | "high"
type ApprovalMode = "guarded" | "autonomous" | "full_access"

interface ApprovalMeta {
  status?: ApprovalStatus | string
  risk?: RiskLevel | string
  mode?: ApprovalMode | string
  reason?: string
  capabilities?: string[]
  audit?: {
    visible?: boolean
  }
  smartAllow?: { risk: string; reason: string; confidence: number } | { skipped: true; reason: string }
}

export interface ApprovalAudit {
  icon: string | null
  iconClass: string
  tooltip: string
}

const STATUS_ICON: Record<string, string | null> = {
  user_allowed: "stamp",
  pending_user: "hourglass",
  user_denied: "badge-x",
  auto_denied: "octagon-alert",
  policy_denied: "octagon-alert",
  sandbox_blocked: "shield-x",
  pre_authorized: "badge-check",
  not_required: null,
}

const AUTO_ALLOWED_ICON: Record<string, string> = {
  guarded: "shield-check",
  autonomous: "orbit",
  full_access: "shield-alert",
}

const AUTO_ALLOWED_COLOR: Record<string, string> = {
  guarded: "text-icon-success-base",
  autonomous: "text-icon-interactive-base",
  full_access: "text-icon-warning-base",
}

const STATUS_COLOR: Record<string, string> = {
  user_allowed: "text-icon-success-base",
}

const DENIED_STATUSES = new Set(["auto_denied", "policy_denied", "user_denied", "sandbox_blocked"])

// ── Descriptors ─────────────────────────────────────────────────────

function d(id: string, message: string): MessageDescriptor {
  return { id, message }
}

const STATUS_LABEL_DESC: Record<string, MessageDescriptor> = {
  auto_allowed: d("approval.auto-allowed", "Auto approved"),
  user_allowed: d("approval.user-allowed", "User approved"),
  pending_user: d("approval.awaiting-approval", "Awaiting approval"),
  user_denied: d("approval.user-denied", "User denied"),
  auto_denied: d("approval.auto-denied", "Auto denied"),
  policy_denied: d("approval.policy-denied", "Policy denied"),
  sandbox_blocked: d("approval.sandbox-blocked", "Sandbox blocked"),
  pre_authorized: d("approval.pre-authorized", "Pre-authorized"),
}

const RISK_DESC: Record<string, MessageDescriptor> = {
  low: d("approval.risk.low", "Low"),
  medium: d("approval.risk.medium", "Medium"),
  high: d("approval.risk.high", "High"),
}

function explain(status: string, mode?: string, risk?: string, reason?: string): string {
  if (reason) return reason
  if (status === "sandbox_blocked") {
    return "This tool requires sandboxing which was unavailable."
  }
  switch (mode) {
    case "guarded": {
      if (risk !== "low") {
        return "Guarded mode applies capability-specific approval rules before shell, external writes, identity, platform, or extension actions."
      }
      return "Guarded mode allowed this automatically."
    }
    case "autonomous": {
      if (risk === "high") {
        return "Autonomous mode blocks high-risk capabilities."
      }
      if (status === "auto_allowed") {
        return "Autonomous mode allowed this automatically."
      }
      return "Autonomous mode manages requests without user interaction."
    }
    case "full_access":
      return "Full Access mode allows all requests."
    default:
      return ""
  }
}

function formatSmartAllow(smartAllow: NonNullable<ApprovalMeta["smartAllow"]>): string {
  if ("skipped" in smartAllow) return `Smart allow skipped: ${smartAllow.reason}`
  return `Smart allow: ${smartAllow.risk} risk, ${(smartAllow.confidence * 100).toFixed(0)}% confidence`
}

function resolveMsg(i18n: I18n | undefined, desc: MessageDescriptor, values?: Record<string, unknown>): string {
  if (i18n) return i18n._({ ...desc, values })
  return desc.message ?? desc.id
}

export function getApprovalAudit(approval: ApprovalMeta | null | undefined, i18n?: I18n): ApprovalAudit {
  const empty: ApprovalAudit = { icon: null, iconClass: "", tooltip: "" }
  if (!approval) return empty
  const status = approval.status ?? ""
  if (!status || status === "not_required") return empty
  if (approval.audit?.visible !== true) return empty

  const { risk, mode, reason } = approval

  let icon: string | null
  let iconClass: string

  if (DENIED_STATUSES.has(status)) {
    icon = STATUS_ICON[status] ?? null
    iconClass = "text-icon-critical-base"
  } else if (status === "auto_allowed") {
    icon = (mode ? AUTO_ALLOWED_ICON[mode] : undefined) ?? "badge-check"
    iconClass = (mode ? AUTO_ALLOWED_COLOR[mode] : undefined) ?? "text-icon-base"
  } else {
    icon = STATUS_ICON[status] ?? null
    iconClass = STATUS_COLOR[status] ?? "text-icon-base"
  }

  if (!icon) return empty

  const labelDesc = STATUS_LABEL_DESC[status]
  const label = labelDesc ? resolveMsg(i18n, labelDesc) : status
  const riskAdj = risk ? (RISK_DESC[risk] ? resolveMsg(i18n, RISK_DESC[risk]) : risk) : null
  const line1 = riskAdj ? `${label} \u00b7 ${riskAdj} risk` : label
  const line2 = explain(status, mode, risk, reason)
  const saLine = approval.smartAllow ? formatSmartAllow(approval.smartAllow) : undefined
  const parts = [line1, line2, saLine].filter(Boolean) as string[]
  const tooltip = parts.join("\n")

  return { icon, iconClass, tooltip }
}
