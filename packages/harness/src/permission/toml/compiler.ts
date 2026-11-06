import * as os from "os"
import type { PermissionProfileToml } from "./types"
import type { SynergyFileSystemSandboxPolicy, SynergyNetworkSandboxPolicy } from "../../sandbox/policy-engine"
import { DEFAULT_PROTECTED_PATHS } from "../../sandbox/policy"

export interface CompileOptions {
  workspace: string
  sandboxMode?: "none" | "read_only" | "workspace_write"
}

export interface CompiledProfile {
  fileSystem: SynergyFileSystemSandboxPolicy
  network: SynergyNetworkSandboxPolicy & { allowedDomains: string[] }
}

function isGlob(p: string): boolean {
  return p.includes("*") || p.includes("?") || p.includes("[") || p.includes("{")
}

const SPECIAL_PATHS: Record<string, (profile: PermissionProfileToml) => string[]> = {
  ":workspace_roots": (profile) => profile.workspace_roots ?? [],
  ":tmpdir": () => [os.tmpdir()],
  ":root": () => ["/"],
}

function resolvePath(p: string, profile: PermissionProfileToml): string[] | null {
  if (!p.startsWith(":")) return [p]
  const resolver = SPECIAL_PATHS[p]
  if (resolver) return resolver(profile)
  return null // unknown special path → warn + skip
}

export namespace TomlCompiler {
  export function compile(profile: PermissionProfileToml, opts: CompileOptions): CompiledProfile {
    const homedir = os.homedir()
    const workspace = opts.workspace
    const sandboxMode = opts.sandboxMode ?? "read_only"

    const fs = profile.filesystem
    const readPaths = fs?.read ?? []
    const writePaths = fs?.write ?? []
    const denyPaths = fs?.deny ?? []

    // Resolve read paths
    const readableRoots: string[] = []
    for (const p of readPaths) {
      const resolved = resolvePath(p, profile)
      if (resolved !== null) {
        for (const r of resolved) {
          if (!readableRoots.includes(r)) readableRoots.push(r)
        }
      }
    }

    // Resolve write paths (only for workspace_write mode)
    const writableRoots: string[] = []
    if (sandboxMode === "workspace_write") {
      // Workspace itself is always writable in workspace_write mode
      if (!writableRoots.includes(workspace)) writableRoots.push(workspace)
      for (const p of writePaths) {
        const resolved = resolvePath(p, profile)
        if (resolved !== null) {
          for (const r of resolved) {
            if (!writableRoots.includes(r)) writableRoots.push(r)
          }
        }
      }
    }

    // Deny paths: glob → unreadableGlobs, exact → dataDenyRoots
    const unreadableGlobs: string[] = []
    const dataDenyRoots: string[] = []
    for (const p of denyPaths) {
      if (isGlob(p)) {
        unreadableGlobs.push(p)
      } else {
        dataDenyRoots.push(p)
      }
    }

    // Homedir is always a data deny root
    if (!dataDenyRoots.includes(homedir)) {
      dataDenyRoots.push(homedir)
    }

    // Read-only subpaths: deny paths that fall under any writable root
    const readOnlySubpaths: string[] = []
    for (const dp of denyPaths) {
      for (const wr of writableRoots) {
        if (dp.startsWith(wr + "/") || dp === wr) {
          if (!readOnlySubpaths.includes(dp)) readOnlySubpaths.push(dp)
          break
        }
      }
    }

    const protectedMetadataNames = [".git", ".agents", ".codex", ".synergy"]

    const fileSystem: SynergyFileSystemSandboxPolicy = {
      readableRoots,
      writableRoots,
      readOnlySubpaths,
      unreadableGlobs,
      protectedMetadataNames,
      protectedPaths: DEFAULT_PROTECTED_PATHS(homedir, workspace),
      dataDenyRoots,
      includePlatformDefaults: true,
      workspace,
    }

    // Network
    const nw = profile.network
    const networkEnabled = nw?.enabled ?? false
    const networkMode = nw?.mode ?? "full"
    const domains = (nw?.domains ?? []).map((d) => d.toLowerCase())

    const mode = networkEnabled ? (networkMode === "limited" ? "restricted" : "full") : "restricted"

    const network: SynergyNetworkSandboxPolicy & { allowedDomains: string[] } = {
      mode,
      allowLocalBinding: nw?.allow_local_binding ?? networkEnabled,
      allowedUnixSockets: (nw?.unix_sockets ?? []).map((s) => s.sock_path),
      allowedDomains: domains,
    }

    return { fileSystem, network }
  }
}
