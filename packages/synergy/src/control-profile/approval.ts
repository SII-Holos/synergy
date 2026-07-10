import type { Capability } from "@/enforcement/gate"
import type { ProfileApproval, ProfileRule, RiskLevel } from "./types"
import { capabilityRisk, permissionCapability } from "@ericsanchezok/synergy-util/capability"

interface ApprovalProfile {
  approval: ProfileApproval
  ruleset: ProfileRule[]
}

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
  source: "profile" | "automatic" | "user" | "sandbox" | "provenance" | "smart_allow"
  mode?: ProfileApproval["mode"]
  risk?: RiskLevel
  reason?: string
  capabilities?: string[]
  audit?: {
    visible: boolean
  }
  time?: {
    requestedAt?: number
    approvalStartedAt?: number
    approvalResolvedAt?: number
    executionStartedAt?: number
    approvalWaitMs?: number
  }
  smartAllow?: {
    risk: string
    reason: string
    confidence: number
  }
}

function riskForCapability(capability: string): RiskLevel {
  return capabilityRisk(capability)
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
    return "Guarded mode applies capability-specific approval rules before shell, external writes, identity, or platform actions."
  }
  if (approval.mode === "autonomous" && risk === "high") {
    return "Autonomous mode blocks high-risk capabilities instead of prompting while the user is away."
  }
  if (approval.mode === "full_access") return "Full Access mode allows this request without approval."
  return `Profile allows ${risk}-risk capabilities: ${capabilities.join(", ")}.`
}

function ruleAction(profile: ApprovalProfile, capability: string): "allow" | "ask" | "deny" {
  const rule = profile.ruleset.find((item) => item.permission === capability)
  return rule?.action ?? actionForRisk(profile.approval, riskForCapability(capability))
}

function actionForProfile(profile: ApprovalProfile, risk: RiskLevel, capabilities: string[]) {
  if (profile.approval.mode === "full_access") return "allow"
  if (capabilities.length === 0) return actionForRisk(profile.approval, risk)

  let asks = false
  for (const capability of capabilities) {
    const action = ruleAction(profile, capability)
    if (action === "deny") return "deny"
    if (action === "ask") asks = true
  }

  if (!asks) return "allow"
  if (profile.approval.mode === "autonomous") return "deny"
  return "ask"
}

const ALWAYS_VISIBLE_AUDIT_STATUSES = new Set([
  "pending_user",
  "user_allowed",
  "user_denied",
  "auto_denied",
  "policy_denied",
  "sandbox_blocked",
])

function auditVisible(metadata: ApprovalMetadata): boolean {
  const status = metadata.status
  if (!status || status === "not_required") return false
  if (ALWAYS_VISIBLE_AUDIT_STATUSES.has(status)) return true

  const risk = metadata.risk
  const mode = metadata.mode
  if (status === "pre_authorized") return risk !== "low" && mode !== "full_access"
  if (status !== "auto_allowed") return false
  if (risk === "low" || mode === "full_access") return false
  if (metadata.source === "smart_allow" || metadata.source === "user" || metadata.source === "provenance") return true
  return mode === "autonomous"
}

export namespace ApprovalPolicy {
  export function riskForPermissions(permissions: string[]): RiskLevel {
    return maxRisk(permissions.map((permission) => riskForCapability(permissionCapability(permission))))
  }

  export function decideCapabilities(profile: ApprovalProfile, capabilities: Capability[]): ApprovalDecision {
    const names = capabilities.map((cap) => cap.class)
    const risk = maxRisk(
      capabilities.length ? capabilities.map((cap) => (cap.opaque ? "high" : riskForCapability(cap.class))) : ["low"],
    )
    return {
      action: actionForProfile(profile, risk, names),
      source: "profile",
      risk,
      reason: reasonFor(profile.approval, risk, names.length ? names : ["tool_request"]),
      capabilities: names.length ? names : ["tool_request"],
    }
  }

  export function decidePermission(
    profile: ApprovalProfile,
    permission: string,
    metadata: Record<string, unknown> | undefined,
  ): ApprovalDecision {
    const capability = String(metadata?.capability ?? permissionCapability(permission))
    const risk = metadata?.nonBypassable || metadata?.opaque ? "high" : riskForCapability(capability)
    return {
      action: actionForProfile(profile, risk, [capability]),
      source: "profile",
      risk,
      reason: reasonFor(profile.approval, risk, [capability]),
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
      audit: { visible: false },
    }
  }

  export function withAudit(metadata: ApprovalMetadata): ApprovalMetadata {
    return {
      ...metadata,
      audit: {
        visible: auditVisible(metadata),
      },
    }
  }
}
