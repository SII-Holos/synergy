import * as path from "path"
import * as os from "os"
import * as fs from "fs"
import * as crypto from "crypto"
import type { PrepareLinuxWrapperOpts, SandboxExecutionWrapper } from "./types"
import { detectPlatform } from "./detect"
import { DEFAULT_PROTECTED_PATHS, defaultRuntimeReadRoots, joinPathLike } from "./policy"
import { Log } from "@/util/log"
import { isWsl1 } from "./wsl"
import { isTarballHelperUpToDate, verifyHelperHash } from "./utils"

const log = Log.create({ service: "sandbox-linux" })

// ------------------------------------------------------------------
// Helper binary detection
// ------------------------------------------------------------------

/**
 * Known search paths for the Linux sandbox helper binary.
 * Priority order: bundled with Synergy, then global bin directory,
 * then node_modules (global + home), then tarball sandbox.
 */
export const LINUX_HELPER_SEARCH_PATHS = [
  // Bundled with Synergy installation
  (homedir: string) => path.posix.join(homedir, ".synergy", "sandbox-helper", "synergy-sandbox-linux"),
  // Global Synergy binary directory
  (homedir: string) => path.posix.join(homedir, ".synergy", "bin", "synergy-sandbox-linux"),
  // Global npm install — node_modules in user home
  (homedir: string) =>
    path.posix.join(
      homedir,
      "node_modules",
      "@ericsanchezok",
      "synergy-sandbox-linux-x64",
      "bin",
      "synergy-sandbox-linux",
    ),
  // System-wide npm install
  (_homedir: string) =>
    path.posix.join(
      "/usr/lib/node_modules",
      "@ericsanchezok",
      "synergy-sandbox-linux-x64",
      "bin",
      "synergy-sandbox-linux",
    ),
]

/**
 * One-time initialization: detect and install the sandbox helper from a
 * tarball-relative sandbox/ directory next to the bundled synergy binary.
 *
 * Standalone tarball layout:
 *   synergy-linux-x64/
 *   ├── bin/synergy
 *   └── sandbox/
 *       └── synergy-sandbox-linux
 *
 * Only runs when the current binary is inside a `bin/` subdirectory of
 * a release tarball — never when running from source (`bun run`).
 * Copies the helper to ~/.synergy/sandbox-helper/ if found and verified.
 * Non-fatal: warns and returns false on any error.
 */
function installTarballHelper(): boolean {
  const execPath = process.execPath
  const execDir = path.dirname(execPath)
  const execDirName = path.basename(execDir)

  // Guard: only install from tarball layout where the binary is inside a
  // `bin/` subdirectory. Prevents false positives when running from source.
  if (execDirName !== "bin") return false

  const tarballSandboxDir = path.resolve(execDir, "..", "sandbox")
  const tarballHelper = path.join(tarballSandboxDir, "synergy-sandbox-linux")

  if (!fs.existsSync(tarballHelper)) return false

  const homedir = os.homedir()
  const destDir = path.join(homedir, ".synergy", "sandbox-helper")
  const destPath = path.join(destDir, "synergy-sandbox-linux")

  // Idempotent: skip if destination already in search results is enough —
  // but copy if the tarball version differs.
  try {
    if (fs.existsSync(destPath) && isTarballHelperUpToDate(tarballHelper, destPath)) {
      return true
    }
  } catch {
    // Fall through to copy
  }

  try {
    fs.mkdirSync(destDir, { recursive: true })
    fs.copyFileSync(tarballHelper, destPath)
    fs.chmodSync(destPath, 0o755)
    log.info("Installed sandbox helper from tarball", { src: tarballHelper, dest: destPath })
    return true
  } catch (e) {
    log.warn("Failed to install tarball sandbox helper", {
      src: tarballHelper,
      dest: destPath,
      error: String(e),
    })
    return false
  }
}

/**
 * One-time: discover a locally-built helper from `cargo build --release`.
 * Only runs when NOT inside a tarball layout — source-deploy use case.
 *
 * Scans a few well-known locations under the workspace root for the helper
 * binary and copies it to ~/.synergy/sandbox-helper/ if found and newer.
 * Non-fatal: returns false on any error.
 */
function tryInstallCargoHelper(): boolean {
  const execPath = process.execPath
  const execDirName = path.basename(path.dirname(execPath))

  // Only attempt cargo discovery when NOT inside a tarball layout.
  // The tarball layout already handles this in installTarballHelper().
  if (execDirName === "bin") return false

  // resolveWorkspaceRoot is import-dynamic to avoid circular deps.
  // Fall back to a simple heuristic: walk up from __dirname looking for
  // a .git directory as the workspace root.
  let workspaceRoot = import.meta.dir
  for (let i = 0; i < 5; i++) {
    const candidate = path.dirname(workspaceRoot)
    if (!candidate || candidate === workspaceRoot) break
    workspaceRoot = candidate
    if (fs.existsSync(path.join(workspaceRoot, ".git"))) break
  }

  // Well-known cargo target paths from workspace root
  const cargoPaths = [
    path.join(
      workspaceRoot,
      "packages",
      "synergy",
      "src",
      "sandbox",
      "helper-linux",
      "target",
      "release",
      "synergy-sandbox-linux",
    ),
  ]

  const homedir = os.homedir()
  const destDir = path.join(homedir, ".synergy", "sandbox-helper")
  const destPath = path.join(destDir, "synergy-sandbox-linux")

  for (const srcPath of cargoPaths) {
    try {
      if (fs.existsSync(srcPath) && (!fs.existsSync(destPath) || !isTarballHelperUpToDate(srcPath, destPath))) {
        fs.mkdirSync(destDir, { recursive: true })
        fs.copyFileSync(srcPath, destPath)
        fs.chmodSync(destPath, 0o755)
        log.info("Installed sandbox helper from cargo build", { src: srcPath, dest: destPath })
        return true
      }
    } catch {
      continue
    }
  }
  return false
}

// ------------------------------------------------------------------
// Bundled bwrap detection and hash verification
// ------------------------------------------------------------------

/**
 * Search path for the bundled bwrap binary.
 */
export const BWRAP_SEARCH_PATHS = [
  (homedir: string) => path.join(homedir, ".synergy", "sandbox-helper", "bwrap", "bwrap"),
]

/**
 * Trusted SHA-256 hashes for bundled bwrap binaries.
 * Populated by the release pipeline after building static bwrap.
 * Never load from config — embedded at compile time.
 *
 * Graceful degradation: when empty (pre-release state), the verification
 * function allows execution with a warning instead of blocking.
 */
export const TRUSTED_BWRAP_HASHES: Record<string, string> = {
  // Hash entries for verified bwrap binaries. Run scripts/download-bwrap.sh to build.
  // Empty map is intentional until release — bwrap will be allowed with a warning.
}

/**
 * Verify the bundled bwrap binary against trusted hashes.
 *
 * When the trusted hash map is not yet populated (pre-release state):
 * - Checks minimum file size (>= 50KB — bwrap static builds are substantial)
 * - Runs `bwrap_path --version` and verifies exit code 0 with expected output
 * - If both checks pass: returns true with log.info (plausible pre-release binary)
 * - If either check fails: returns false with log.warn
 *
 * When hashes are populated:
 * - Hash matches: verified.
 * - Hash mismatch: blocks exec.
 *
 * Returns true if the binary should be trusted (verified or pre-release checks pass).
 */
function verifyBwrapHash(binaryPath: string): boolean {
  const trustedHash = TRUSTED_BWRAP_HASHES[binaryPath]

  // Graceful degradation: if no trusted hash is embedded (pre-release),
  // run minimum plausibility checks instead of unconditionally allowing.
  if (!trustedHash || trustedHash.length === 0) {
    // Check 1: Minimum file size. bwrap static builds are at least 50KB.
    try {
      const stat = fs.statSync(binaryPath)
      if (stat.size < 50 * 1024) {
        log.warn("Bundled bwrap is too small — refusing to trust", {
          path: binaryPath,
          size: stat.size,
        })
        return false
      }
    } catch {
      return false
    }

    // Check 2: Run --version and verify output looks like bwrap/bubblewrap.
    try {
      const proc = Bun.spawnSync({
        cmd: [binaryPath, "--version"],
        stdout: "pipe",
        stderr: "pipe",
      })
      if (proc.exitCode !== 0) {
        log.warn("Bundled bwrap --version failed — refusing to trust", {
          path: binaryPath,
          exitCode: proc.exitCode,
        })
        return false
      }
      const output = proc.stdout.toString()
      if (!/bubblewrap|bwrap/i.test(output)) {
        log.warn("Bundled bwrap --version output does not contain expected identifiers", {
          path: binaryPath,
          output: output.slice(0, 200),
        })
        return false
      }
    } catch (e) {
      log.warn("Bundled bwrap --version check failed", {
        path: binaryPath,
        error: String(e),
      })
      return false
    }

    log.info("Bwrap hash table empty (pre-release) — binary passed minimum plausibility checks", {
      path: binaryPath,
    })
    return true
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
 * Find the bundled bwrap binary and verify its hash.
 * Returns { path, verified } if found, or null if not present at any search path.
 */
export function findBundledBwrap(): { path: string; verified: boolean } | null {
  const homedir = os.homedir()
  for (const getPath of BWRAP_SEARCH_PATHS) {
    const p = getPath(homedir)
    try {
      if (fs.existsSync(p)) {
        const verified = verifyBwrapHash(p)
        if (!verified) {
          log.warn("Bundled bwrap hash verification failed", { path: p })
        }
        return { path: p, verified }
      }
    } catch {
      continue
    }
  }
  return null
}

/**
 * Check if a verified bundled bwrap binary is available.
 * Returns true only when the binary exists and hash verification passes
 * (or hash table is empty — pre-release graceful degradation).
 */
export function isBundledBwrapAvailable(): boolean {
  const bwrap = findBundledBwrap()
  return bwrap !== null && bwrap.verified
}

/**
 * Trusted SHA-256 hashes for Linux helper binaries.
 * Updated with every helper binary release.
 * Never load from config — embedded at compile time.
 */
export const TRUSTED_LINUX_HELPER_HASHES: Record<string, string> = {
  ...(typeof SYNERGY_SANDBOX_HELPER_SHA256 === "string" && SYNERGY_SANDBOX_HELPER_SHA256
    ? {
        [path.join(os.homedir(), ".synergy", "sandbox-helper", "synergy-sandbox-linux")]: SYNERGY_SANDBOX_HELPER_SHA256,
      }
    : {}),
}

/**
 * Resolve the path to the sandbox helper binary on Linux.
 * Returns the absolute path if found and hash-verified, or null if not installed.
 */
function findLinuxHelperBinary(): { path: string; verified: boolean } | null {
  // One-time try: install from tarball sandbox/ directory
  installTarballHelper()

  // One-time try: discover locally-built helper (cargo build --release)
  tryInstallCargoHelper()

  const homedir = os.homedir()
  for (const getPath of LINUX_HELPER_SEARCH_PATHS) {
    const p = getPath(homedir)
    try {
      if (fs.existsSync(p)) {
        const verified = verifyHelperHash(p, TRUSTED_LINUX_HELPER_HASHES)
        if (verified) {
          return { path: p, verified: true }
        }
        // Hash mismatch — log warning and continue searching
        log.warn("Linux sandbox helper hash verification failed", { path: p })
        continue
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
  const tmpDir = joinPathLike(workspace, ".synergy", "tmp")
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
   * Helper-backed dispatch (synergy-sandbox-linux Rust helper).
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

    // WSL1 lacks the kernel features required for bwrap namespace sandboxing.
    // Return skipReason instead of failing with cryptic kernel errors.
    if (isWsl1()) {
      return {
        command,
        args,
        sandboxed: false,
        skipReason:
          "WSL1 is unsupported for sandboxing — bwrap requires namespace and seccomp features not available on WSL1. Upgrade to WSL2 for full sandbox support.",
      }
    }
    if (opts.backend === "bwrap-inline-debug") {
      return prepareInlineBwrap(opts)
    }

    // Helper-backed dispatch
    const helper = opts.forceHelperPath
      ? { path: opts.forceHelperPath, verified: opts.forceHelperVerified === true }
      : findLinuxHelperBinary()
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
