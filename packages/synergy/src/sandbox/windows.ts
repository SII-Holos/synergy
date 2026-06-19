import * as os from "os"
import type { PrepareWrapperOpts, SandboxExecutionWrapper } from "./types"
import { detectPlatform } from "./platform"

/**
 * Known search paths for the Windows sandbox helper binary.
 * Priority order: project-local, global binary dir, PATH.
 */
const HELPER_SEARCH_PATHS = [
  // Global Synergy binary directory
  (homedir: string) => `${homedir}\\.synergy\\bin\\synergy-sandbox.exe`,
  // Bundled with Synergy installation
  (homedir: string) => `${homedir}\\.synergy\\sandbox-helper\\synergy-sandbox.exe`,
]

/**
 * Resolve the path to the sandbox helper binary on Windows.
 * Returns the absolute path if found, or null if not installed.
 *
 * Phase 3: add SHA-256 hash verification and actual fs.existsSync check.
 */
function findHelperBinary(): string | null {
  const homedir = os.homedir()
  for (const getPath of HELPER_SEARCH_PATHS) {
    const p = getPath(homedir)
    // Phase 3: use fs.existsSync(p) to check
    // For now, always return null — helper doesn't exist yet
    void p
  }
  return null
}

export namespace WindowsBackend {
  /**
   * Prepare a Windows sandbox execution wrapper.
   *
   * Phase 1: returns skipReason ("Windows sandbox not yet implemented").
   * Phase 3: detect helper, build JSON config, return sandboxed wrapper.
   *
   * Security invariants (Phase 3):
   * - `sandboxed: true` only when the helper binary is actually used
   * - Config must be structured JSON, never a shell command string
   * - Helper binary path must be verified outside the workspace boundary
   * - If helper is unavailable and fallback=deny, must NOT execute unsandboxed
   */
  export function prepare(opts: PrepareWrapperOpts): SandboxExecutionWrapper {
    const { command, args, sandboxMode, forcePlatform } = opts

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

    // Phase 3: implement sandboxed execution via Rust helper binary
    return {
      command,
      args,
      sandboxed: false,
      skipReason: "Windows sandbox not yet implemented",
    }
  }
}

/**
 * Detect if the Windows sandbox helper binary is installed and usable.
 *
 * Phase 1: always returns false (helper binary does not exist yet).
 * Phase 3: call this from `platformInfo()` in platform.ts to report
 * Windows sandbox availability to callers.
 */
export function isWindowsHelperAvailable(): boolean {
  return findHelperBinary() !== null
}
