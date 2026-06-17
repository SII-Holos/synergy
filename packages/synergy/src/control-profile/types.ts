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

export interface ControlProfile {
  label: string
  ruleset: ProfileRule[]
  filesystem: ProfileFilesystem
  network: ProfileNetwork
  sandbox: ProfileSandbox
  approvalPolicy: Record<string, unknown>
  allowAllBlocked?: boolean
}

export interface ResolutionContext {
  workspace: string
  workspaceType: string
  interactionMode?: string
}

export interface ResolvedProfile extends ControlProfile {
  valid: boolean
  reason?: string
}

export type ProfileId = "review" | "workspace" | "auto_review" | "full_access"
