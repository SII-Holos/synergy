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

export interface SandboxModelExplanationOptions {
  /** Control profile that governs this session, when known. */
  controlProfile?: string
  /** Path already approved for this session, when the denial is now unblocked. */
  approved?: { path: string; access: "read" | "write" } | null
  /** Backend message used when no structured explanation was produced. */
  message?: string
}

/**
 * The single path a sandbox block can be approved for, when the backend parsed
 * one. Approval plumbing keys off this so a denial without a concrete path
 * never produces an ask.
 */
export function approvablePath(
  expl: SandboxBlockExplanation | null | undefined,
): { path: string; access: "read" | "write" } | undefined {
  const action = expl?.recovery.find((item) => item.type === "approve_path")
  if (!action || action.type !== "approve_path") return undefined
  return { path: action.path, access: action.access }
}

const PARTIAL_SIDE_EFFECT_WARNING = [
  "The command may already have produced partial side effects inside the workspace before it hit this boundary.",
  "Do not assume nothing happened: inspect the workspace (for example `git status`) before continuing.",
].join(" ")

/**
 * Format a sandbox block for the model.
 *
 * A sandbox block is an execution-time boundary, not a policy refusal: the
 * command was authorized and then stopped while running. The text therefore
 * keeps the two apart, names the denied path when the backend parsed one, and
 * states whether that path is approvable for this profile. `autonomous` never
 * prompts, so its denials stay fail-closed and the command cannot be retried
 * as-is. A backend that cannot parse a path still yields a usable explanation.
 */
export function formatExplanationForModel(
  expl: SandboxBlockExplanation | null | undefined,
  options: SandboxModelExplanationOptions = {},
): string {
  const lines: string[] = []
  const autonomous = options.controlProfile === "autonomous"

  lines.push("Sandbox blocked this command at execution time.")
  lines.push(
    "This is an execution-time boundary enforced by the OS sandbox, not a policy refusal: the command was authorized, then stopped while it was running.",
  )
  lines.push("")

  if (!expl) {
    if (options.message) {
      lines.push(options.message)
      lines.push("")
    }
    lines.push(PARTIAL_SIDE_EFFECT_WARNING)
    lines.push("")
    if (autonomous) {
      lines.push(
        "The autonomous profile never prompts: no approval is possible and the command cannot be retried as-is.",
      )
    }
    return lines.join("\n")
  }

  if (expl.path && expl.access) {
    lines.push(`Sandbox denied ${expl.access} access to: ${expl.path}`)
  } else if (expl.networkTarget) {
    lines.push(`Sandbox denied network access to: ${expl.networkTarget}`)
  } else if (expl.deniedPaths.length > 0) {
    lines.push(`Sandbox denied access to: ${expl.deniedPaths.join(", ")}`)
  } else {
    lines.push("Sandbox denied the operation without naming a specific path.")
  }
  if (expl.rawMessage) lines.push(`Raw OS message: ${expl.rawMessage}`)
  lines.push(
    `Platform: ${expl.platform}, Backend: ${expl.backend ?? "none"}, Profile: ${expl.profileMode}, Network: ${expl.networkMode}`,
  )
  if (expl.allowedWriteRoots.length > 0) lines.push(`Writable roots: ${expl.allowedWriteRoots.join(", ")}`)
  if (expl.allowedReadRoots.length > 0) lines.push(`Readable roots: ${expl.allowedReadRoots.join(", ")}`)
  if (expl.deniedPaths.length > 0) lines.push(`Denied paths: ${expl.deniedPaths.join(", ")}`)
  lines.push("")

  lines.push(PARTIAL_SIDE_EFFECT_WARNING)
  lines.push("")

  if (options.approved) {
    lines.push(
      `The user approved ${options.approved.access} access to ${options.approved.path} for this session; it is now part of the sandbox roots. Retry the same command as-is.`,
    )
    return lines.join("\n")
  }

  const offersApproval = expl.recovery.some((item) => item.type === "approve_path")
  const writeApprovable = offersApproval && expl.access === "write"
  if (expl.path) {
    lines.push(`To proceed with ${expl.path}:`)
    lines.push("- Move the operation into the workspace and use a workspace-relative path, then retry.")
    if (autonomous && offersApproval) {
      lines.push(
        "- The autonomous profile never prompts, so no approval is possible: this path cannot be approved and the command cannot be retried as-is. Move the operation into the workspace, or switch profiles, first.",
      )
    } else if (writeApprovable && options.controlProfile === "guarded") {
      lines.push(
        `- Under the guarded profile, request approval for exactly this path: ${expl.path}. Once approved the path enters the sandbox write roots and the same command can be retried.`,
      )
    }
  } else {
    lines.push(
      "No specific path could be identified from this sandbox denial. Re-run with an explicit path inside the workspace, or inspect the raw OS message above.",
    )
    if (autonomous && offersApproval) {
      lines.push(
        "- The autonomous profile never prompts: no approval is possible and the command cannot be retried as-is.",
      )
    }
  }

  if (expl.denialSource === "fallback-deny") {
    lines.push(
      "- The sandbox is unavailable on this platform and this profile fails closed: the command did not run unsandboxed.",
    )
  }
  if (expl.denialSource === "helper-missing" || expl.denialSource === "helper-unverified") {
    lines.push("- Install the platform sandbox helper to restore sandboxed execution.")
  }

  return lines.join("\n")
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
