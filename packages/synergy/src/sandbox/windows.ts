import * as os from "os"
import * as path from "path"
import * as fs from "fs"
import * as crypto from "crypto"
import type { PrepareWrapperOpts, SandboxExecutionWrapper } from "./types"
import { detectPlatform } from "./platform"
import { Log } from "@/util/log"

const log = Log.create({ service: "sandbox-windows" })

// ------------------------------------------------------------------
// Helper binary detection
// ------------------------------------------------------------------

/**
 * Known search paths for the Windows sandbox helper binary.
 * Priority order: bundled with Synergy, then global bin directory.
 */
const HELPER_SEARCH_PATHS = [
  // Bundled with Synergy installation
  (homedir: string) => path.join(homedir, ".synergy", "sandbox-helper", "synergy-sandbox.exe"),
  // Global Synergy binary directory
  (homedir: string) => path.join(homedir, ".synergy", "bin", "synergy-sandbox.exe"),
]

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
        return { path: p, verified }
      }
    } catch {
      // Permission denied or filesystem error — skip this path
      continue
    }
  }
  return null
}

/**
 * Verify the helper binary's SHA-256 hash against a known trusted hash.
 * Returns true if verification passes or is not configured.
 *
 * Phase 3 MVP: return true (no hash configured yet).
 * Phase 4: load trusted hash from config or embedded constant.
 */
function verifyHelperHash(binaryPath: string): boolean {
  // MVP: no hash verification configured — trusted by location
  try {
    const hash = crypto.createHash("sha256")
    const data = fs.readFileSync(binaryPath)
    hash.update(data)
    const digest = hash.digest("hex")
    log.debug(`Helper binary hash: ${digest}`)
    // TODO Phase 4: compare against trusted hash list
    return true
  } catch {
    return false
  }
}

// ------------------------------------------------------------------
// Protected paths
// ------------------------------------------------------------------

function defaultProtectedPaths(homedir: string, workspace: string): string[] {
  return [
    path.join(workspace, ".git"),
    path.join(homedir, ".synergy", "config"),
    path.join(homedir, ".synergy", "data", "auth", "api-key.json"),
  ]
}

// ------------------------------------------------------------------
// Windows sandbox config (mirrors helper/src/config.rs)
// ------------------------------------------------------------------

interface WindowsSandboxConfig {
  level: "restricted-token" | "elevated"
  mode: "read_only" | "workspace_write"
  workspace: string
  execution_cwd: string
  writable_roots: string[]
  read_roots: string[]
  protected_paths: string[]
  data_deny_roots: string[]
  command: string
  args: string[]
}

// ------------------------------------------------------------------
// WindowsBackend
// ------------------------------------------------------------------

export namespace WindowsBackend {
  /**
   * Prepare a Windows sandbox execution wrapper.
   *
   * Phase 3: detects the Rust helper binary, builds JSON config,
   * writes it to a temp file, and returns a sandboxed wrapper that
   * invokes synergy-sandbox.exe with the config.
   *
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

    // Locate the helper binary
    const helper = findHelperBinary()
    if (!helper) {
      return {
        command,
        args,
        sandboxed: false,
        skipReason: "Windows sandbox helper binary not found. Install the Synergy sandbox helper for Windows.",
      }
    }

    if (!helper.verified) {
      return {
        command,
        args,
        sandboxed: false,
        skipReason: "Windows sandbox helper binary hash verification failed.",
      }
    }

    const homedir = os.homedir()

    // Build the sandbox config
    const config: WindowsSandboxConfig = {
      level: "restricted-token",
      mode: sandboxMode,
      workspace,
      execution_cwd: opts.executionCwd ?? workspace,
      writable_roots: [workspace, ...(opts.writableRoots ?? []), ...(opts.extraWritableRoots ?? [])],
      read_roots: [path.join(homedir, ".synergy"), ...(opts.runtimeReadRoots ?? []), ...(opts.extraReadRoots ?? [])],
      protected_paths: defaultProtectedPaths(homedir, workspace),
      data_deny_roots: opts.dataDenyRoots ?? [],
      command,
      args,
    }

    // Write config to temp file
    const tempDir = os.tmpdir()
    const configPath = path.join(tempDir, `synergy-sandbox-${Math.random().toString(36).slice(2, 10)}.json`)
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")

    return {
      command: helper.path,
      args: ["--config", configPath, "--", command, ...args],
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
