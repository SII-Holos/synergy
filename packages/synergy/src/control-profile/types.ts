export interface ProfileRule {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
  nonBypassable?: boolean
}

export interface ProfileFilesystem {
  readRoots: string[]
  writeRoots: string[]
  protectedPaths: string[]
}

export interface ProfileNetwork {
  mode: "disabled" | "restricted" | "enabled"
}

export interface ProfileSandbox {
  mode: "none" | "workspace_write" | "read_only"
  fallback: "deny" | "warn" | "allow"
}

export type ApprovalMode = "guarded" | "autonomous" | "full_access"
export type ApprovalAction = "allow" | "ask" | "deny"
export type RiskLevel = "low" | "medium" | "high"

export interface ProfileApproval {
  mode: ApprovalMode
  lowRisk: ApprovalAction
  mediumRisk: ApprovalAction
  highRisk: ApprovalAction
}

export interface ControlProfile {
  label: string
  description: string
  ruleset: ProfileRule[]
  filesystem: ProfileFilesystem
  network: ProfileNetwork
  sandbox: ProfileSandbox
  approval: ProfileApproval
}

export interface ResolutionContext {
  workspace: string
  workspaceType: string
  interactionMode?: string
}

export interface ProfileSummary {
  profileId: string
  sandbox: ProfileSandbox
  label: string
  brief: string
  approval: ProfileApproval
  deniedCapabilities: string[]
  workspaceRoot: string
}

export interface ResolvedProfile extends ControlProfile {
  valid: boolean
  reason?: string
  summary?: ProfileSummary
}

export type ProfileId = "guarded" | "autonomous" | "full_access"
export type ProfileIdInput = ProfileId
