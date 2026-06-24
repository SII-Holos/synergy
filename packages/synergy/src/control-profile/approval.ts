import type { Capability } from "@/enforcement/gate"
import type { ProfileApproval, RiskLevel } from "./types"

export interface ApprovalDecision {
  action: "allow" | "ask" | "deny"
  source: "profile"
  risk: RiskLevel
  reason: string
  capabilities: string[]
}

export interface ApprovalMetadata {
  status:
    | "not_required"
    | "pending_user"
    | "user_allowed"
    | "user_denied"
    | "auto_allowed"
    | "auto_denied"
    | "policy_denied"
    | "sandbox_blocked"
    | "pre_authorized"
  source: "profile" | "automatic" | "user" | "sandbox" | "provenance" | "classifier"
  mode?: ProfileApproval["mode"]
  risk?: RiskLevel
  reason?: string
  capabilities?: string[]
  time?: {
    requestedAt?: number
    approvalStartedAt?: number
    approvalResolvedAt?: number
    executionStartedAt?: number
    approvalWaitMs?: number
  }
}

const HIGH_RISK = new Set([
  "shell_hardline",
  "shell_destructive",
  "file_external_read",
  "file_external_write",

  "mcp_invoke",
  "plugin_invoke",
  "plugin_file_read",
  "plugin_file_write",
  "plugin_shell",
  "plugin_network",
  "plugin_secret_read",
  "identity_act",
  "communication_email",
  "channel_outbound",
  "platform_control",
  "protected_op",
])

const MEDIUM_RISK = new Set(["file_write", "shell", "network_request"])

const PERMISSION_CAPABILITY: Record<string, string> = {
  read: "file_read",
  view_file: "file_read",
  scan_files: "file_read",
  parse_code: "file_read",
  grep: "file_read",
  glob: "file_read",
  list: "file_read",
  edit: "file_write",
  write: "file_write",
  revise_file: "file_write",
  save_file: "file_write",
  bash: "shell",
  external_directory: "file_external_read",
  webfetch: "network_read",
  websearch: "network_read",
  arxiv_search: "network_read",
  arxiv_download: "network_read",
  network_request: "network_request",
  email_read: "communication_email",
  email_send: "communication_email",
  communication_email: "communication_email",
  session_send: "channel_outbound",
  channel_outbound: "channel_outbound",
  identity_act: "identity_act",
  platform_control: "platform_control",
}

function riskForCapability(capability: string): RiskLevel {
  if (HIGH_RISK.has(capability)) return "high"
  if (MEDIUM_RISK.has(capability)) return "medium"
  return "low"
}

function maxRisk(risks: RiskLevel[]): RiskLevel {
  if (risks.includes("high")) return "high"
  if (risks.includes("medium")) return "medium"
  return "low"
}

function actionForRisk(approval: ProfileApproval, risk: RiskLevel) {
  if (risk === "high") return approval.highRisk
  if (risk === "medium") return approval.mediumRisk
  return approval.lowRisk
}

function reasonFor(approval: ProfileApproval, risk: RiskLevel, capabilities: string[]) {
  if (approval.mode === "guarded" && risk !== "low") {
    return "Guarded mode applies capability-specific approval rules before shell, external, identity, platform, or extension actions."
  }
  if (approval.mode === "autonomous" && risk === "high") {
    return "Autonomous mode blocks high-risk capabilities instead of prompting while the user is away."
  }
  if (approval.mode === "full_access") return "Full Access mode allows this request without approval."
  return `Profile allows ${risk}-risk capabilities: ${capabilities.join(", ")}.`
}

export namespace ApprovalPolicy {
  export function riskForPermissions(permissions: string[]): RiskLevel {
    return maxRisk(permissions.map((permission) => riskForCapability(PERMISSION_CAPABILITY[permission] ?? permission)))
  }

  export function decideCapabilities(approval: ProfileApproval, capabilities: Capability[]): ApprovalDecision {
    const names = capabilities.length ? capabilities.map((cap) => cap.class) : ["tool_request"]
    const risk = maxRisk(
      capabilities.length
        ? capabilities.map((cap) => (cap.opaque ? "high" : riskForCapability(cap.class)))
        : ["medium"],
    )
    return {
      action: actionForRisk(approval, risk),
      source: "profile",
      risk,
      reason: reasonFor(approval, risk, names),
      capabilities: names,
    }
  }

  export function decidePermission(
    approval: ProfileApproval,
    permission: string,
    metadata: Record<string, unknown> | undefined,
  ): ApprovalDecision {
    const capability = String(metadata?.capability ?? PERMISSION_CAPABILITY[permission] ?? permission)
    const risk = metadata?.nonBypassable || metadata?.opaque ? "high" : riskForCapability(capability)
    return {
      action: actionForRisk(approval, risk),
      source: "profile",
      risk,
      reason: reasonFor(approval, risk, [capability]),
      capabilities: [capability],
    }
  }

  export function metadata(
    approval: ProfileApproval,
    decision: ApprovalDecision,
    status?: ApprovalMetadata["status"],
  ): ApprovalMetadata {
    return {
      status:
        status ??
        (decision.action === "ask" ? "pending_user" : decision.action === "deny" ? "auto_denied" : "auto_allowed"),
      source: approval.mode === "autonomous" ? "automatic" : "profile",
      mode: approval.mode,
      risk: decision.risk,
      reason: decision.reason,
      capabilities: decision.capabilities,
    }
  }
}
