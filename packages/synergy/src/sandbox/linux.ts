import * as path from "path"
import * as os from "os"
import * as fs from "fs"
import type { PrepareLinuxWrapperOpts, SandboxExecutionWrapper } from "./types"
import { detectPlatform } from "./detect"
import { DEFAULT_PROTECTED_PATHS, defaultRuntimeReadRoots } from "./policy"

/**
 * Linux platform default read roots.
 * These are the essential system directories needed by most commands.
 * Mirrors Codex's LINUX_PLATFORM_DEFAULT_READ_ROOTS.
 */
const LINUX_PLATFORM_READ_ROOTS = ["/bin", "/sbin", "/usr", "/etc", "/lib", "/lib64"]

/**
 * Ensure a protected path exists before bwrap tries to --ro-bind it.
 * bwrap requires the source path to exist; if it doesn't, the mount
 * is skipped and a sandboxed process could create a malicious config
 * file or directory at that location (CBSE attack vector).
 *
 * Pre-creates missing paths as empty files or directories as needed.
 * Never throws — graceful degradation: returns false if creation fails.
 */
function ensureProtectedPath(protectedPath: string): boolean {
  try {
    fs.statSync(protectedPath)
    return true
  } catch {
    try {
      const parentDir = path.dirname(protectedPath)
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true })
      }
      if (isFilePath(protectedPath)) {
        fs.writeFileSync(protectedPath, "# Synergy sandbox protected placeholder. Do not remove.\n", "utf-8")
      } else {
        fs.mkdirSync(protectedPath, { recursive: true })
      }
      return true
    } catch {
      return false
    }
  }
}

/** Heuristic for missing protected paths that should be pre-created as files. */
function isFilePath(protectedPath: string): boolean {
  const ext = path.extname(protectedPath)
  if (ext) return true
  const knownFileBasenames = new Set([
    ".netrc",
    ".npmrc",
    ".gitconfig",
    ".git-credentials",
    ".bashrc",
    ".zshrc",
    ".profile",
    ".bash_profile",
    ".zprofile",
  ])
  return knownFileBasenames.has(path.basename(protectedPath))
}

export namespace LinuxBackend {
  /**
   * Prepare a Linux bwrap sandbox wrapper.
   *
   * Mount strategy:
   * 1. Platform read roots mounted as --ro-bind (read-only).
   * 2. Runtime read roots (from approved permissions) mounted as --ro-bind.
   * 3. Workspace mounted as --bind (read-write) or --ro-bind (read-only).
   * 4. Controlled tmp: .synergy/tmp or /tmp bind.
   * 5. --dev /dev and --proc /proc for basic process introspection.
   * 6. --unshare-user --unshare-pid for namespace isolation.
   *
   * Key invariants:
   * - NEVER --ro-bind / /
   * - read_only mode must enforce read-only workspace
   * - Protected paths (.git, .synergy/config, etc.) must not be writable
   */
  export function prepare(opts: PrepareLinuxWrapperOpts): SandboxExecutionWrapper {
    const {
      command,
      args,
      workspace,
      sandboxMode,
      runtimeReadRoots,
      extraReadRoots,
      extraWritableRoots,
      forcePlatform,
    } = opts

    if (sandboxMode === "none") {
      return { command, args, sandboxed: false }
    }

    const platform = forcePlatform ?? detectPlatform()
    if (platform !== "linux") {
      return {
        command,
        args,
        sandboxed: false,
        skipReason: `Linux sandbox (bwrap) not available on platform "${platform}"`,
      }
    }

    const homedir = os.homedir()
    const bwrapArgs: string[] = []

    // Namespace isolation
    bwrapArgs.push("--new-session", "--die-with-parent")
    bwrapArgs.push("--unshare-user", "--unshare-pid")

    // Device and process mounts
    bwrapArgs.push("--dev", "/dev")
    bwrapArgs.push("--proc", "/proc")

    // Platform default read-only roots
    for (const root of LINUX_PLATFORM_READ_ROOTS) {
      bwrapArgs.push("--ro-bind", root, root)
    }

    // Runtime read roots (from approved permissions / defaultRuntimeReadRoots)
    const allReadRoots = runtimeReadRoots ?? defaultRuntimeReadRoots(homedir)
    for (const root of allReadRoots) {
      bwrapArgs.push("--ro-bind", root, root)
    }

    // Extra read roots (from caller — e.g. permitted tool paths)
    for (const root of extraReadRoots ?? []) {
      bwrapArgs.push("--ro-bind", root, root)
    }

    // Workspace mount: read-only or read-write based on sandbox mode
    if (sandboxMode === "read_only") {
      bwrapArgs.push("--ro-bind", workspace, workspace)
    } else {
      bwrapArgs.push("--bind", workspace, workspace)

      // Extra writable roots (from caller — e.g. permitted tool output paths)
      for (const root of extraWritableRoots ?? []) {
        bwrapArgs.push("--bind", root, root)
      }

      // Protected paths: ensure existence then ro-bind to prevent writes.
      // Pre-creating missing paths closes the CBSE vector where a sandboxed
      // process creates a malicious config file that executes on the host.
      const protectedPaths = DEFAULT_PROTECTED_PATHS(homedir, workspace)
      for (const protectedPath of protectedPaths) {
        ensureProtectedPath(protectedPath)
        bwrapArgs.push("--ro-bind", protectedPath, protectedPath)
      }
    }

    // Controlled tmp
    const tmpDir = path.join(workspace, ".synergy", "tmp")
    bwrapArgs.push("--bind", tmpDir, "/tmp")

    // Separator
    bwrapArgs.push("--")

    return {
      command: "bwrap",
      args: [...bwrapArgs, command, ...args],
      sandboxed: true,
    }
  }
}
