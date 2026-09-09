import type { SandboxMode } from "./types"

export type SandboxBlockKind = "filesystem" | "network" | "process" | "helper" | "policy" | "unknown"

export type DenialSource = "os" | "policy-compiler" | "helper-missing" | "helper-unverified" | "fallback-deny"

export type PlatformName = "macos" | "linux" | "windows" | "unsupported"

export type FileAccess = "read" | "write" | "execute" | "metadata"

export type SandboxNetworkMode = "full" | "restricted" | "proxy_only"

/**
 * Structured explanation of a sandbox block.
 * Contains enough information for user-facing error messages and recovery suggestions.
 */
export interface SandboxBlockExplanation {
  kind: SandboxBlockKind
  platform: PlatformName
  backend: string | null
  command: string
  access?: FileAccess
  path?: string
  networkTarget?: string
  requiredPermission?: string
  profileMode: SandboxMode
  networkMode: SandboxNetworkMode
  allowedReadRoots: string[]
  allowedWriteRoots: string[]
  deniedPaths: string[]
  denialSource: DenialSource
  rawMessage?: string
  recovery: SandboxRecoveryAction[]
}

/**
 * Recovery actions a user or agent can take after a sandbox block.
 */
export type SandboxRecoveryAction =
  | { type: "approve_path"; path: string; access: "read" | "write" }
  | { type: "approve_network"; target?: string }
  | { type: "install_helper"; backend: string; instructions?: string }
  | { type: "rerun_with_profile"; profile: "full_access" | "guarded" | "autonomous" }
  | { type: "open_readiness" }
  | { type: "move_to_workspace"; path: string }
  | { type: "switch_backend"; backend: string }

/**
 * Build a SandboxBlockExplanation from structured inputs.
 */
export function buildExplanation(inputs: {
  kind: SandboxBlockKind
  platform: PlatformName
  backend: string | null
  command: string
  access?: FileAccess
  path?: string
  networkTarget?: string
  denialSource: DenialSource
  rawMessage?: string
  profileMode?: SandboxMode
  networkMode?: SandboxNetworkMode
  allowedReadRoots?: string[]
  allowedWriteRoots?: string[]
  deniedPaths?: string[]
}): SandboxBlockExplanation {
  const profileMode = inputs.profileMode ?? "workspace_write"
  const networkMode = inputs.networkMode ?? "restricted"
  const allowedReadRoots = inputs.allowedReadRoots ?? []
  const allowedWriteRoots = inputs.allowedWriteRoots ?? []
  const deniedPaths = inputs.deniedPaths ?? []

  return {
    kind: inputs.kind,
    platform: inputs.platform,
    backend: inputs.backend,
    command: inputs.command,
    access: inputs.access,
    path: inputs.path,
    networkTarget: inputs.networkTarget,
    profileMode,
    networkMode,
    allowedReadRoots,
    allowedWriteRoots,
    deniedPaths,
    denialSource: inputs.denialSource,
    rawMessage: inputs.rawMessage,
    recovery: computeRecovery(inputs),
  }
}

function computeRecovery(inputs: {
  kind: SandboxBlockKind
  platform: PlatformName
  access?: FileAccess
  path?: string
  networkTarget?: string
  denialSource: DenialSource
}): SandboxRecoveryAction[] {
  const recovery: SandboxRecoveryAction[] = []

  // Default: always offer rerun with full_access as an escape hatch
  recovery.push({ type: "rerun_with_profile", profile: "full_access" })

  switch (inputs.denialSource) {
    case "helper-missing":
      recovery.push({
        type: "install_helper",
        backend: "synergy-sandbox-" + inputs.platform,
        instructions: `Install the Synergy sandbox helper for ${inputs.platform}`,
      })
      recovery.push({ type: "open_readiness" })
      break

    case "helper-unverified":
      recovery.push({
        type: "install_helper",
        backend: "synergy-sandbox-" + inputs.platform,
        instructions: "Sandbox helper binary hash verification failed. Reinstall the helper.",
      })
      break

    case "os":
    case "policy-compiler":
    case "fallback-deny":
      if (inputs.path && inputs.access) {
        if (inputs.access === "read" || inputs.access === "write") {
          recovery.push({ type: "approve_path", path: inputs.path, access: inputs.access })
        }
        recovery.push({ type: "move_to_workspace", path: inputs.path })
      }
      if (inputs.networkTarget) {
        recovery.push({ type: "approve_network", target: inputs.networkTarget })
      }
      break
  }

  return recovery
}

/**
 * Format a SandboxBlockExplanation into a human-readable string.
 */
export function formatExplanation(expl: SandboxBlockExplanation): string {
  const lines: string[] = []

  lines.push(`Command blocked by ${expl.platform} sandbox (${expl.backend ?? "no backend"}).`)
  lines.push("")

  if (expl.rawMessage) {
    lines.push(`OS message: ${expl.rawMessage}`)
    lines.push("")
  }

  switch (expl.denialSource) {
    case "os":
      if (expl.path && expl.access) {
        lines.push(`Sandbox denied ${expl.access} access to: ${expl.path}`)
      } else if (expl.networkTarget) {
        lines.push(`Sandbox denied network access to: ${expl.networkTarget}`)
      } else {
        lines.push(`Sandbox denied execution: ${expl.rawMessage ?? "operation not permitted"}`)
      }
      break

    case "policy-compiler":
      lines.push("The sandbox policy compiler could not express the required permissions.")
      break

    case "helper-missing":
      lines.push(`Sandbox helper binary not found for ${expl.platform}.`)
      lines.push("Install the Synergy sandbox helper to enable sandbox execution on this platform.")
      break

    case "helper-unverified":
      lines.push("Sandbox helper binary hash verification failed. The helper may be corrupted or tampered.")
      break

    case "fallback-deny":
      lines.push(`Sandbox is unavailable on ${expl.platform} and fallback policy is deny.`)
      break
  }

  lines.push("")
  lines.push(`Profile: ${expl.profileMode}, Network mode: ${expl.networkMode}`)

  if (expl.allowedReadRoots.length > 0) {
    lines.push(`Readable roots: ${expl.allowedReadRoots.join(", ")}`)
  }
  if (expl.allowedWriteRoots.length > 0) {
    lines.push(`Writable roots: ${expl.allowedWriteRoots.join(", ")}`)
  }
  if (expl.deniedPaths.length > 0) {
    lines.push(`Denied paths: ${expl.deniedPaths.join(", ")}`)
  }

  if (expl.recovery.length > 0) {
    lines.push("")
    lines.push("Recovery options:")
    for (const r of expl.recovery) {
      switch (r.type) {
        case "approve_path":
          lines.push(`  - Approve ${r.access} access to ${r.path}`)
          break
        case "approve_network":
          lines.push(`  - Approve network access${r.target ? ` to ${r.target}` : ""}`)
          break
        case "install_helper":
          lines.push(`  - Install sandbox helper: ${r.instructions ?? r.backend}`)
          break
        case "rerun_with_profile":
          lines.push(`  - Rerun with ${r.profile} profile (bypasses sandbox)`)
          break
        case "open_readiness":
          lines.push("  - Open sandbox readiness page for diagnostics")
          break
        case "move_to_workspace":
          lines.push(`  - Move ${r.path} into the workspace`)
          break
        case "switch_backend":
          lines.push(`  - Switch to ${r.backend} sandbox backend`)
          break
      }
    }
  }

  return lines.join("\n")
}
