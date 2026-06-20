import * as os from "os"
import * as path from "path"
import * as fs from "fs"
import * as crypto from "crypto"
import type { PrepareWrapperOpts, SandboxExecutionWrapper } from "./types"
import { detectPlatform } from "./detect"
import { Log } from "@/util/log"
import { DEFAULT_PROTECTED_PATHS } from "./policy"
import { buildPermissionProfile } from "./policy-engine"

const log = Log.create({ service: "sandbox-windows" })

// ------------------------------------------------------------------
// Helper binary detection
// ------------------------------------------------------------------

/**
 * Known search paths for the Windows sandbox helper binary.
 * Priority order: bundled with Synergy, then global bin directory.
 */
export const WINDOWS_HELPER_BINARY_NAME = "synergy-sandbox-windows.exe"

export const HELPER_SEARCH_PATHS = [
  // Bundled with Synergy installation
  (homedir: string) => path.join(homedir, ".synergy", "sandbox-helper", WINDOWS_HELPER_BINARY_NAME),
  // Global Synergy binary directory
  (homedir: string) => path.join(homedir, ".synergy", "bin", WINDOWS_HELPER_BINARY_NAME),
]
/**
 * Trusted SHA-256 hashes for helper binaries.
 * Updated with every helper binary release.
 * Never load from config — embedded at compile time.
 */
export const TRUSTED_HELPER_HASHES: Record<string, string> = {
  // Hash entries for verified helper binaries. Run scripts/build-helper.ts windows --auto-update to populate.
  // Empty map is intentional until release — no helper will be trusted.
}

/**
 * Resolve the path to the sandbox helper binary on Windows.
 * Returns the absolute path if found and hash-verified, or null if not installed.
 */
function findHelperBinary(): { path: string; verified: boolean } | null {
  const homedir = os.homedir()
  for (const getPath of HELPER_SEARCH_PATHS) {
    const p = getPath(homedir)
    try {
      if (fs.existsSync(p)) {
        const verified = verifyHelperHash(p)
        if (verified) {
          return { path: p, verified: true }
        }
        // Hash mismatch — log warning and continue searching
        log.warn("Windows sandbox helper hash verification failed", { path: p })
        return { path: p, verified: false }
      }
    } catch {
      // Permission denied or filesystem error — skip this path
      continue
    }
  }
  return null
}

function verifyHelperHash(binaryPath: string): boolean {
  const trustedHash = TRUSTED_HELPER_HASHES[binaryPath]
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
   * Phase 3: detects the Rust helper binary, builds JSON config,
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
