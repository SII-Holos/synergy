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
  ...(typeof SYNERGY_SANDBOX_HELPER_SHA256 === "string" && SYNERGY_SANDBOX_HELPER_SHA256
    ? {
        [path.join(os.homedir(), ".synergy", "sandbox-helper", "synergy-sandbox-windows.exe")]:
          SYNERGY_SANDBOX_HELPER_SHA256,
      }
    : {}),
}

export type WindowsHelperArchitecture = "x64" | "arm64" | "x86" | "unknown"
export type WindowsHelperHashStatus = "verified" | "mismatch" | "missing"

export interface WindowsHelperInfo {
  path: string
  verified: boolean
  architecture: WindowsHelperArchitecture
  expectedArchitecture: WindowsHelperArchitecture
  architectureMatches: boolean
  hashStatus: WindowsHelperHashStatus
}

function expectedHelperArchitecture(): WindowsHelperArchitecture {
  if (process.arch === "arm64") return "arm64"
  if (process.arch === "ia32") return "x86"
  return "x64"
}

function helperArchitecture(binaryPath: string): WindowsHelperArchitecture {
  try {
    const contents = fs.readFileSync(binaryPath)
    if (contents.length < 0x86 || contents.subarray(0, 2).toString("ascii") !== "MZ") return "unknown"
    const peOffset = contents.readUInt32LE(0x3c)
    if (
      peOffset < 0 ||
      peOffset + 6 > contents.length ||
      contents.subarray(peOffset, peOffset + 4).toString("ascii") !== "PE\0\0"
    ) {
      return "unknown"
    }
    const machine = contents.readUInt16LE(peOffset + 4)
    if (machine === 0x8664) return "x64"
    if (machine === 0xaa64) return "arm64"
    if (machine === 0x14c) return "x86"
    return "unknown"
  } catch {
    return "unknown"
  }
}

export function inspectWindowsHelper(
  binaryPath: string,
  trustedHashes: Record<string, string> = TRUSTED_WINDOWS_HELPER_HASHES,
): WindowsHelperInfo {
  const architecture = helperArchitecture(binaryPath)
  const expectedArchitecture = expectedHelperArchitecture()
  const architectureMatches = architecture === expectedArchitecture
  const hasTrustedHash = Object.values(trustedHashes).some((hash) => hash.length > 0)
  const hashStatus: WindowsHelperHashStatus = !hasTrustedHash
    ? "missing"
    : verifyHelperHash(binaryPath, trustedHashes)
      ? "verified"
      : "mismatch"

  return {
    path: binaryPath,
    verified: architectureMatches && hashStatus === "verified",
    architecture,
    expectedArchitecture,
    architectureMatches,
    hashStatus,
  }
}

/**
 * Resolve the Windows helper and retain the first invalid candidate for diagnostics.
 * Returns null only when no helper binary exists at any search path.
 *
 * The probe re-validates the binary on every call: the previous stat-signature
 * cache (size + mtime) could be spoofed by replacing the helper with different
 * bytes of the same length and restoring its modification time, which would
 * skip the embedded SHA-256 integrity check and let a tampered binary execute
 * sandboxed commands. Verification cost is a bounded read + digest per command;
 * integrity wins over the small latency saving.
 */
export function findHelperBinary(
  searchPaths: readonly ((homedir: string) => string)[] = WINDOWS_HELPER_SEARCH_PATHS,
): WindowsHelperInfo | null {
  // Try tarball-relative installation before searching standard paths
  installTarballHelper()

  const homedir = os.homedir()
  let firstInvalid: WindowsHelperInfo | null = null
  for (const getPath of searchPaths) {
    const p = getPath(homedir)
    try {
      if (fs.existsSync(p)) {
        const info = inspectWindowsHelper(p)
        if (info.verified) return info
        firstInvalid ??= info
        log.warn("Windows sandbox helper validation failed", {
          path: p,
          architecture: info.architecture,
          expectedArchitecture: info.expectedArchitecture,
          hashStatus: info.hashStatus,
        })
      }
    } catch {
      // Permission denied or filesystem error — skip this path
      continue
    }
  }
  return firstInvalid
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
      ? {
          path: opts.forceHelperPath,
          verified: opts.forceHelperVerified === true,
          architecture: expectedHelperArchitecture(),
          expectedArchitecture: expectedHelperArchitecture(),
          architectureMatches: true,
          hashStatus: opts.forceHelperVerified === true ? ("verified" as const) : ("mismatch" as const),
        }
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
      if (!helper.architectureMatches) {
        return {
          command,
          args,
          sandboxed: false,
          skipReason: `Windows sandbox helper architecture mismatch: found ${helper.architecture}, expected ${helper.expectedArchitecture}. Install the matching ${helper.expectedArchitecture} helper.`,
        }
      }
      if (helper.hashStatus === "missing") {
        return {
          command,
          args,
          sandboxed: false,
          skipReason:
            "Windows sandbox helper hash verification is unavailable because no trusted SHA-256 digest is embedded. Reinstall a packaged Synergy runtime.",
        }
      }
      return {
        command,
        args,
        sandboxed: false,
        skipReason:
          "Windows sandbox helper binary hash verification failed. The helper may be corrupted or tampered. Reinstall the Synergy Windows sandbox helper.",
      }
    }

    const homedir = os.homedir()
    const dataDenyRoots = [...(opts.dataDenyRoots ?? [])]
    // The shared home deny root would also deny a workspace below it on Windows; strip only that default.
    if (opts.stripDefaultHomeDenyRoot) {
      const defaultRootIndex = dataDenyRoots.indexOf(homedir)
      if (defaultRootIndex >= 0) dataDenyRoots.splice(defaultRootIndex, 1)
    }

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
      protectedPaths: opts.protectedPaths,
      dataDenyRoots,
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
export function getWindowsHelperInfo(): WindowsHelperInfo | null {
  return findHelperBinary()
}
