import * as path from "path"
import * as os from "os"
import * as fs from "fs"
import * as crypto from "crypto"
import type { PrepareLinuxWrapperOpts, SandboxExecutionWrapper } from "./types"
import { detectPlatform } from "./detect"
import { DEFAULT_PROTECTED_PATHS, defaultRuntimeReadRoots } from "./policy"
import { Log } from "@/util/log"

const log = Log.create({ service: "sandbox-linux" })

// ------------------------------------------------------------------
// Helper binary detection
// ------------------------------------------------------------------

/**
 * Known search paths for the Linux sandbox helper binary.
 * Priority order: bundled with Synergy, then global bin directory.
 */
export const LINUX_HELPER_SEARCH_PATHS = [
  // Bundled with Synergy installation
  (homedir: string) => path.join(homedir, ".synergy", "sandbox-helper", "synergy-sandbox-linux"),
  // Global Synergy binary directory
  (homedir: string) => path.join(homedir, ".synergy", "bin", "synergy-sandbox-linux"),
]

/**
 * Trusted SHA-256 hashes for Linux helper binaries.
 * Updated with every helper binary release.
 * Never load from config — embedded at compile time.
 */
export const TRUSTED_LINUX_HELPER_HASHES: Record<string, string> = {
  // Phase 2 baseline: placeholder — will be replaced with actual hash when helper binary is built
  // The empty map means "no trusted hash yet — helper cannot be verified"
}

function verifyHelperHash(binaryPath: string): boolean {
  const trustedHash = TRUSTED_LINUX_HELPER_HASHES[binaryPath]
  // If no trusted hash is embedded, refuse to trust the binary
  if (!trustedHash || trustedHash.length === 0) {
    return false
  }
  try {
    const hash = crypto.createHash("sha256")
    const data = fs.readFileSync(binaryPath)
    hash.update(data)
    const digest = hash.digest("hex")
    // Constant-time comparison
    if (digest.length !== trustedHash.length) return false
    let result = 0
    for (let i = 0; i < digest.length; i++) {
      result |= digest.charCodeAt(i) ^ trustedHash.charCodeAt(i)
    }
    return result === 0
  } catch {
    return false
  }
}

/**
 * Resolve the path to the sandbox helper binary on Linux.
 * Returns the absolute path if found and hash-verified, or null if not installed.
 */
function findLinuxHelperBinary(): { path: string; verified: boolean } | null {
  const homedir = os.homedir()
  for (const getPath of LINUX_HELPER_SEARCH_PATHS) {
    const p = getPath(homedir)
    try {
      if (fs.existsSync(p)) {
        const verified = verifyHelperHash(p)
        if (verified) {
          return { path: p, verified: true }
        }
        // Hash mismatch — log warning and continue searching
        log.warn("Linux sandbox helper hash verification failed", { path: p })
        return { path: p, verified: false }
      }
    } catch {
      // Permission denied or filesystem error — skip this path
      continue
    }
  }
  return null
}

/**
 * Detect if the Linux sandbox helper is installed and verified.
 * Used by platformInfo() to report availability.
 */
export function isLinuxHelperAvailable(): boolean {
  const helper = findLinuxHelperBinary()
  return helper !== null && helper.verified
}

/**
 * Detailed diagnostic info about the Linux sandbox helper.
 * Returns null if no helper binary found at any search path.
 */
export function getLinuxHelperInfo(): { path: string; verified: boolean } | null {
  return findLinuxHelperBinary()
}

// ------------------------------------------------------------------
// Linux platform default read roots
// ------------------------------------------------------------------

/**
 * Linux platform default read roots.
 * These are the essential system directories needed by most commands.
 * Mirrors Codex's LINUX_PLATFORM_DEFAULT_READ_ROOTS.
 */
const LINUX_PLATFORM_READ_ROOTS = ["/bin", "/sbin", "/usr", "/etc", "/lib", "/lib64"]

// ------------------------------------------------------------------
// Protected path helpers (shared by bwrap-inline-debug)
// ------------------------------------------------------------------

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

// ------------------------------------------------------------------
// Inline bwrap (opt-in only via backend:"bwrap-inline-debug")
// ------------------------------------------------------------------

/**
 * Prepare an inline bwrap sandbox wrapper.
 * This is the legacy implementation, now only accessible via
 * explicit backend:"bwrap-inline-debug" opt-in.
 */
function prepareInlineBwrap(opts: PrepareLinuxWrapperOpts): SandboxExecutionWrapper {
  const { command, args, workspace, sandboxMode, runtimeReadRoots, extraReadRoots, extraWritableRoots } = opts

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

// ------------------------------------------------------------------
// LinuxBackend
// ------------------------------------------------------------------

export namespace LinuxBackend {
  /**
   * Prepare a Linux sandbox execution wrapper.
   *
   * Phase 2: helper-backed dispatch (synergy-sandbox-linux Rust helper).
   * Inline bwrap is opt-in only via backend:"bwrap-inline-debug".
   *
   * Security invariants:
   * - sandboxed: true only when the helper binary is actually used
   * - If helper is unavailable, returns skipReason to signal unavailability
   * - NEVER --ro-bind / / in inline bwrap path
   * - read_only mode must enforce read-only workspace
   * - Protected paths must not be writable
   */
  export function prepare(opts: PrepareLinuxWrapperOpts): SandboxExecutionWrapper {
    const { command, args, sandboxMode, forcePlatform } = opts

    if (sandboxMode === "none") {
      return { command, args, sandboxed: false }
    }

    const platform = forcePlatform ?? detectPlatform()
    if (platform !== "linux") {
      return {
        command,
        args,
        sandboxed: false,
        skipReason: `Linux sandbox not available on platform "${platform}"`,
      }
    }

    // Explicit opt-in to inline bwrap for debugging/comparison
    if (opts.backend === "bwrap-inline-debug") {
      return prepareInlineBwrap(opts)
    }

    // Phase 2: helper-backed dispatch
    const helper = findLinuxHelperBinary()
    if (!helper) {
      return {
        command,
        args,
        sandboxed: false,
        skipReason: "synergy-sandbox-linux helper not found. Install the Synergy sandbox helper for Linux.",
      }
    }

    if (!helper.verified) {
      return {
        command,
        args,
        sandboxed: false,
        skipReason:
          "synergy-sandbox-linux helper hash verification failed. The helper may be corrupted or tampered. Reinstall the Synergy Linux sandbox helper.",
      }
    }

    const homedir = os.homedir()
    const workspace = opts.workspace

    // Build the sandbox permission profile JSON for the helper
    const profile: Record<string, unknown> = {
      fileSystem: {
        workspace,
        readableRoots: [
          workspace,
          ...(opts.runtimeReadRoots ?? defaultRuntimeReadRoots(homedir)),
          ...(opts.extraReadRoots ?? []),
        ],
        writableRoots: opts.sandboxMode === "workspace_write" ? [workspace, ...(opts.extraWritableRoots ?? [])] : [],
        readOnlySubpaths: DEFAULT_PROTECTED_PATHS(homedir, workspace),
        protectedPaths: DEFAULT_PROTECTED_PATHS(homedir, workspace),
        includePlatformDefaults: true,
      },
      network: {
        mode: "restricted",
        allowLocalBinding: false,
        allowedUnixSockets: [],
      },
    }

    // Write profile to a private temp file. The helper consumes this path before
    // entering bwrap; keep the file unpredictable and owner-readable only.
    const tmpDir = os.tmpdir()
    const profilePath = path.join(tmpDir, `synergy-sandbox-linux-${crypto.randomBytes(8).toString("hex")}.json`)
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), { encoding: "utf-8", mode: 0o600 })

    return {
      command: helper.path,
      args: ["--sandbox-policy-cwd", opts.workspace, "--permission-profile", profilePath, "--", command, ...args],
      sandboxed: true,
      tempPath: profilePath,
    }
  }
}
