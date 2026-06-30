import type { Capability } from "@/enforcement/gate"
import type { ProfileApproval, RiskLevel } from "./types"
import { capabilityRisk, permissionCapability } from "@ericsanchezok/synergy-util/capability"

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
  time?: {
    requestedAt?: number
    approvalStartedAt?: number
    approvalResolvedAt?: number
    executionStartedAt?: number
    approvalWaitMs?: number
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
    return "Guarded mode applies capability-specific approval rules before shell, external, identity, or platform actions."
  }
  if (approval.mode === "autonomous" && risk === "high") {
    return "Autonomous mode blocks high-risk capabilities instead of prompting while the user is away."
  }
  if (approval.mode === "full_access") return "Full Access mode allows this request without approval."
  return `Profile allows ${risk}-risk capabilities: ${capabilities.join(", ")}.`
}

export namespace ApprovalPolicy {
  export function riskForPermissions(permissions: string[]): RiskLevel {
    return maxRisk(permissions.map((permission) => riskForCapability(permissionCapability(permission))))
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
    const capability = String(metadata?.capability ?? permissionCapability(permission))
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
