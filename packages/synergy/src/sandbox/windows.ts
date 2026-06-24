import * as os from "os"
import * as path from "path"
import * as fs from "fs"
import * as crypto from "crypto"
import type { PrepareWrapperOpts, SandboxExecutionWrapper } from "./types"
import { detectPlatform } from "./detect"
import { Log } from "@/util/log"
import { DEFAULT_PROTECTED_PATHS } from "./policy"
import { buildPermissionProfile } from "./policy-engine"
import { isTarballHelperUpToDate, verifyHelperHash } from "./utils"

const log = Log.create({ service: "sandbox-windows" })

// ------------------------------------------------------------------
// Helper binary detection
// ------------------------------------------------------------------

/**
 * Known search paths for the Windows sandbox helper binary.
 * Priority order: bundled with Synergy, then global bin directory.
 */
export const WINDOWS_HELPER_BINARY_NAME = "synergy-sandbox-windows.exe"

export const WINDOWS_HELPER_SEARCH_PATHS = [
  // Bundled with Synergy installation
  (homedir: string) => path.join(homedir, ".synergy", "sandbox-helper", WINDOWS_HELPER_BINARY_NAME),
  // Global Synergy binary directory
  (homedir: string) => path.join(homedir, ".synergy", "bin", WINDOWS_HELPER_BINARY_NAME),
  // Global npm install — node_modules in user home
  (homedir: string) =>
    path.join(
      homedir,
      "node_modules",
      "@ericsanchezok",
      "synergy-sandbox-windows-x64",
      "bin",
      WINDOWS_HELPER_BINARY_NAME,
    ),
  // System-wide npm install (%ProgramFiles% equivalent)
  (_homedir: string) =>
    path.join(
      "C:\\Program Files\\node_modules",
      "@ericsanchezok",
      "synergy-sandbox-windows-x64",
      "bin",
      WINDOWS_HELPER_BINARY_NAME,
    ),
]

/**
 * One-time initialization: detect and install the sandbox helper from a
 * tarball-relative sandbox/ directory next to the bundled synergy binary.
 *
 * Standalone tarball layout:
 *   synergy-windows-x64/
 *   ├── bin/synergy.exe
 *   └── sandbox/
 *       └── synergy-sandbox-windows.exe
 *
 * Only runs when the current binary is inside a `bin/` subdirectory of
 * a release tarball — never when running from source (`bun run`).
 * Copies the helper to ~/.synergy/sandbox-helper/ if found.
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
  const tarballHelper = path.join(tarballSandboxDir, WINDOWS_HELPER_BINARY_NAME)

  if (!fs.existsSync(tarballHelper)) return false

  const homedir = os.homedir()
  const destDir = path.join(homedir, ".synergy", "sandbox-helper")
  const destPath = path.join(destDir, WINDOWS_HELPER_BINARY_NAME)

  // Idempotent: skip if destination already exists and is up to date.
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
 * Trusted SHA-256 hashes for Windows helper binaries.
 * Updated with every helper binary release.
 * Never load from config — embedded at compile time.
 */
export const TRUSTED_WINDOWS_HELPER_HASHES: Record<string, string> = {
  [path.join(os.homedir(), ".synergy", "sandbox-helper", "synergy-sandbox-windows.exe")]:
    "038835d500dd0e2c1fac4dcf829e0bb13ebadd69373d77f19b575758b3437b5b",
}

/**
 * Resolve the path to the sandbox helper binary on Windows.
 * Returns the absolute path if found and hash-verified, or null if not installed.
 */
function findHelperBinary(): { path: string; verified: boolean } | null {
  // Try tarball-relative installation before searching standard paths
  installTarballHelper()

  const homedir = os.homedir()
  for (const getPath of WINDOWS_HELPER_SEARCH_PATHS) {
    const p = getPath(homedir)
    try {
      if (fs.existsSync(p)) {
        const verified = verifyHelperHash(p, TRUSTED_WINDOWS_HELPER_HASHES)
        if (verified) {
          return { path: p, verified: true }
        }
        // Hash mismatch — log warning and continue searching
        log.warn("Windows sandbox helper hash verification failed", { path: p })
        continue
      }
    } catch {
      // Permission denied or filesystem error — skip this path
      continue
    }
  }
  return null
}

// ------------------------------------------------------------------
// Windows sandbox config (mirrors helper/src/config.rs)
// ------------------------------------------------------------------

// Windows helper consumes the same SynergySandboxPermissionProfile JSON as the
// Linux helper. Process command/args are passed after `--` in argv.

// ------------------------------------------------------------------
// WindowsBackend
// ------------------------------------------------------------------

export namespace WindowsBackend {
  /**
   * Prepare a Windows sandbox execution wrapper.
   *
   * Detects the Rust helper binary, builds JSON config,
   * writes it to a temp file, and returns a sandboxed wrapper that
   * invokes synergy-sandbox-windows.exe with a shared PermissionProfile config.
   * Security invariants:
   * - `sandboxed: true` only when the helper binary is actually used
   * - Config is structured JSON, never a shell command string
   * - Helper binary path is verified outside the workspace boundary
   * - If helper is unavailable, this backend returns skipReason to signal unavailability
   */
  export function prepare(opts: PrepareWrapperOpts): SandboxExecutionWrapper {
    const { command, args, workspace, sandboxMode, forcePlatform } = opts

    if (sandboxMode === "none") {
      return { command, args, sandboxed: false }
    }

    const platform = forcePlatform ?? detectPlatform()
    if (platform !== "windows") {
      return {
        command,
        args,
        sandboxed: false,
        skipReason: `Windows sandbox not available on platform "${platform}"`,
      }
    }

    const helper = opts.forceHelperPath
      ? { path: opts.forceHelperPath, verified: opts.forceHelperVerified === true }
      : findHelperBinary()
    if (!helper) {
      return {
        command,
        args,
        sandboxed: false,
        skipReason: `Windows sandbox helper binary ${WINDOWS_HELPER_BINARY_NAME} not found. Install the Synergy sandbox helper for Windows.`,
      }
    }

    if (!helper.verified) {
      return {
        command,
        args,
        sandboxed: false,
        skipReason:
          "Windows sandbox helper binary hash verification failed. The helper may be corrupted or tampered. Reinstall the Synergy Windows sandbox helper.",
      }
    }

    const homedir = os.homedir()

    const profile = buildPermissionProfile({
      workspace,
      executionCwd: opts.executionCwd ?? workspace,
      sandboxMode,
      approvedReadPaths: [
        path.join(homedir, ".synergy"),
        ...(opts.runtimeReadRoots ?? []),
        ...(opts.extraReadRoots ?? []),
      ],
      approvedWritePaths:
        opts.sandboxMode === "workspace_write"
          ? [...(opts.writableRoots ?? []), ...(opts.extraWritableRoots ?? [])]
          : [],
      approvedNetwork: false,
      approvedUnixSockets: [],
    })

    const tempDir = os.tmpdir()
    const configPath = path.join(tempDir, `synergy-sandbox-windows-${crypto.randomBytes(8).toString("hex")}.json`)
    fs.writeFileSync(configPath, JSON.stringify(profile, null, 2), { encoding: "utf-8", mode: 0o600 })

    return {
      command: helper.path,
      args: ["--permission-profile", configPath, "--cwd", opts.executionCwd ?? workspace, "--", command, ...args],
      sandboxed: true,
      tempPath: configPath,
    }
  }
}

/**
 * Detect if the Windows sandbox helper is installed and verified.
 * Used by platformInfo() to report availability.
 */
export function isWindowsHelperAvailable(): boolean {
  const helper = findHelperBinary()
  return helper !== null && helper.verified
}

/**
 * Detailed diagnostic info about the Windows sandbox helper.
 * Returns null if no helper binary found at any search path.
 */
export function getWindowsHelperInfo(): { path: string; verified: boolean } | null {
  return findHelperBinary()
}
