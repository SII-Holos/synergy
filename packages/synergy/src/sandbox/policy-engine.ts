import * as os from "os"
import { DEFAULT_PROTECTED_PATHS, defaultRuntimeReadRoots } from "./policy"

export type SandboxNetworkMode = "full" | "restricted" | "proxy_only"

export interface SynergyFileSystemSandboxPolicy {
  readableRoots: string[]
  writableRoots: string[]
  readOnlySubpaths: string[]
  unreadableGlobs: string[]
  protectedMetadataNames: string[]
  protectedPaths: string[]
  dataDenyRoots: string[]
  includePlatformDefaults: boolean
  workspace: string
}

export interface SynergyNetworkSandboxPolicy {
  mode: SandboxNetworkMode
  allowLocalBinding: boolean
  allowedUnixSockets: string[]
}

export interface SynergySandboxPermissionProfile {
  fileSystem: SynergyFileSystemSandboxPolicy
  network: SynergyNetworkSandboxPolicy
}

export interface SandboxPolicyInput {
  workspace: string
  executionCwd: string
  sandboxMode: "none" | "read_only" | "workspace_write"
  approvedReadPaths: string[]
  approvedWritePaths: string[]
  approvedNetwork: boolean
  approvedUnixSockets: string[]
}

/**
 * Build a sandbox permission profile from the permission system's approved paths
 * and the control profile's sandbox mode.
 *
 * This is the bridge between "permission system allows X" and "sandbox should allow X".
 */
export function buildPermissionProfile(input: SandboxPolicyInput): SynergySandboxPermissionProfile {
  const homedir = os.homedir()
  const protectedNames = [".git", ".agents", ".codex", ".synergy"]

  // Network policy
  const network: SynergyNetworkSandboxPolicy = input.approvedNetwork
    ? { mode: "full", allowLocalBinding: true, allowedUnixSockets: input.approvedUnixSockets }
    : { mode: "restricted", allowLocalBinding: true, allowedUnixSockets: [] }

  // File system policy
  const readableRoots: string[] = []
  const writableRoots: string[] = []
  const readOnlySubpaths: string[] = []
  const protectedPaths: string[] = DEFAULT_PROTECTED_PATHS(homedir, input.workspace)
  const dataDenyRoots: string[] = [homedir]

  // Always include platform default read roots
  const platformRoots = defaultRuntimeReadRoots(homedir)

  // Workspace is always readable
  readableRoots.push(input.workspace)

  // Platform runtime read roots
  for (const root of platformRoots) {
    readableRoots.push(root)
  }

  // Approved read paths from permission system
  for (const p of input.approvedReadPaths) {
    if (!readableRoots.includes(p)) {
      readableRoots.push(p)
    }
  }

  // Writable roots
  if (input.sandboxMode === "workspace_write") {
    writableRoots.push(input.workspace)
  }

  // Approved write paths from permission system
  for (const p of input.approvedWritePaths) {
    if (!writableRoots.includes(p)) {
      writableRoots.push(p)
    }
  }

  // Read-only subpaths: protect critical files inside writable roots
  for (const p of protectedPaths) {
    readOnlySubpaths.push(p)
  }

  // Execution CWD is always readable
  if (input.executionCwd !== input.workspace) {
    readableRoots.push(input.executionCwd)
  }

  const fileSystem: SynergyFileSystemSandboxPolicy = {
    readableRoots,
    writableRoots,
    readOnlySubpaths,
    unreadableGlobs: [], // Phase 2: add glob deny from approval system
    protectedMetadataNames: protectedNames,
    protectedPaths,
    dataDenyRoots,
    includePlatformDefaults: true,
    workspace: input.workspace,
  }

  return { fileSystem, network }
}

/**
 * Check if the requested policy can be enforced by a given platform backend.
 * Returns null on success, or the reason it cannot be enforced.
 */
export function canEnforceOnPlatform(
  profile: SynergySandboxPermissionProfile,
  platform: "macos" | "linux" | "windows",
): string | null {
  const fs = profile.fileSystem

  switch (platform) {
    case "windows":
      // Windows restricted-token cannot enforce deny-read
      if (fs.unreadableGlobs.length > 0 && fs.dataDenyRoots.length > 0) {
        return "Windows restricted-token backend cannot enforce deny-read policy. Use the elevated Windows sandbox backend."
      }
      // Windows cannot enforce full-disk write
      if (fs.writableRoots.length === 0 && !fs.includePlatformDefaults) {
        return "Windows sandbox requires at least one writable root."
      }
      break
    case "linux":
      // Linux can enforce all policies
      break
    case "macos":
      // macOS can enforce all policies via Seatbelt
      break
  }
  return null
}
