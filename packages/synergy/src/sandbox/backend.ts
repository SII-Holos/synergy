// ---------------------------------------------------------------------------
// SandboxBackend — unified dispatch layer
//
// Platform-specific logic lives in sibling modules:
//   macos.ts   — macOS sandbox-exec + Seatbelt profile generation
//   linux.ts   — Linux bwrap (bubblewrap)
//   windows.ts — Windows sandbox (Phase 1 skeleton, Phase 3 full)
//   policy.ts  — shared policy constants and helpers
//   platform.ts — platform detection and temp dir resolution
//   types.ts   — all shared interfaces and type aliases
//
// This file imports from those modules and provides:
//   1. Re-exports of all public types (backward compat)
//   2. SandboxBackend namespace with platform dispatch
//   3. The shared execute() function
//
// Design invariants:
//   - prepareWrapper writes a temp .sb profile; execute cleans it in finally.
//   - Seatbelt uses allow-default for OS viability, then explicitly denies user-data roots
//     and re-allows the active workspace / controlled temp paths.
//   - Protected paths (deny file-write*) follow write-allow rules (last-match-wins).
//   - bwrap never --ro-bind /; only runtime roots + workspace + controlled tmp.
// ---------------------------------------------------------------------------

import type {
  PlatformInfo,
  PrepareWrapperOpts,
  PrepareLinuxWrapperOpts,
  SeatbeltProfileOpts,
  SandboxExecutionWrapper,
  ExecuteOpts,
  ExecuteResult,
} from "./types"

// ------------------------------------------------------------------
// Type re-exports (backward compat)
// ------------------------------------------------------------------

export type {
  PlatformInfo,
  PrepareWrapperOpts,
  PrepareLinuxWrapperOpts,
  SeatbeltProfileOpts,
  SandboxExecutionWrapper,
  ExecuteOpts,
  ExecuteResult,
} from "./types"

// ------------------------------------------------------------------
// Imports from sibling modules
// ------------------------------------------------------------------

import { detectPlatform, isPlatformSupported as platformIsSupported, platformInfo as getPlatformInfo } from "./platform"
import { MacBackend } from "./macos"
import { LinuxBackend } from "./linux"
import { WindowsBackend } from "./windows"

// ------------------------------------------------------------------
// SandboxBackend — unified public API
// ------------------------------------------------------------------

export namespace SandboxBackend {
  export const platformInfo = getPlatformInfo
  export const generateSeatbeltProfile = MacBackend.generateSeatbeltProfile
  export const cleanupTemp = MacBackend.cleanupTemp

  /**
   * Check whether a given os.platform() string is supported.
   *
   * "darwin" / "macos" → true, "linux" → true, "win32" / "windows" → true.
   * Use platformInfo().available to check whether a sandbox backend is
   * actually usable on the current machine.
   */
  export function isPlatformSupported(rawPlatform: string): boolean {
    return platformIsSupported(rawPlatform)
  }

  // ----------------------------------------------------------------
  // Wrapper preparation
  // ----------------------------------------------------------------

  /**
   * Prepare a sandbox execution wrapper for the current platform.
   *
   * macOS   → sandbox-exec -f <tmpProfile> <command> <args...>
   * linux   → bwrap <mounts> -- <command> <args...>
   * windows → Phase 1: skipReason (not yet implemented)
   * none    → returns unwrapped, sandboxed=false
   */
  export function prepareWrapper(opts: PrepareWrapperOpts): SandboxExecutionWrapper {
    if (opts.sandboxMode === "none") {
      return { command: opts.command, args: opts.args, sandboxed: false }
    }

    const platform = opts.forcePlatform ?? detectPlatform()

    switch (platform) {
      case "macos":
        return MacBackend.prepare(opts)
      case "linux": {
        // Convert PrepareWrapperOpts → PrepareLinuxWrapperOpts for bwrap dispatch.
        // Note: executionCwd, extraReadRoots, extraWritableRoots, writableRoots,
        // protectedPaths, and dataDenyRoots are not yet wired to the bwrap backend.
        const linuxOpts: PrepareLinuxWrapperOpts = {
          command: opts.command,
          args: opts.args,
          workspace: opts.workspace,
          sandboxMode: opts.sandboxMode,
          runtimeReadRoots: opts.runtimeReadRoots,
          forcePlatform: opts.forcePlatform,
        }
        return LinuxBackend.prepare(linuxOpts)
      }
      case "windows":
        return WindowsBackend.prepare(opts)
      default:
        return {
          command: opts.command,
          args: opts.args,
          sandboxed: false,
          skipReason: `Sandbox not available on platform "${platform}"`,
        }
    }
  }

  /**
   * Prepare a Linux bwrap (bubblewrap) sandbox wrapper.
   *
   * Key design:
   * - NEVER --ro-bind / /  (full root filesystem exposure)
   * - Bind runtime read roots individually with --bind (read-write, minimal)
   * - Bind active workspace with --bind
   * - Use --bind for controlled tmp
   * - Final args: bwrap <mounts> -- <command> <args...>
   */
  export function prepareLinuxWrapper(opts: PrepareLinuxWrapperOpts): SandboxExecutionWrapper {
    return LinuxBackend.prepare(opts)
  }

  // ----------------------------------------------------------------
  // Execution (shared, platform-agnostic)
  // ----------------------------------------------------------------

  /**
   * Execute the sandbox wrapper.
   *
   * If sandbox is unavailable (skipReason set):
   *   - deny  → throws immediately
   *   - warn  → runs command directly (unsandboxed)
   *   - allow → runs command directly (unsandboxed)
   *
   * If sandbox is active:
   *   - Spawns the wrapper command (e.g. sandbox-exec)
   *   - Cleans up the temp profile in a finally block
   *   - Throws on non-zero exit code
   */
  export function execute(wrapper: SandboxExecutionWrapper, opts?: ExecuteOpts): ExecuteResult {
    // --- unsandboxed fallback path ---
    if (wrapper.skipReason) {
      const policy = opts?.fallbackPolicy ?? "warn"
      if (policy === "deny") {
        throw new Error(`Sandbox execution denied: ${wrapper.skipReason}`)
      }
      // warn / allow: run directly
      const result = Bun.spawnSync({
        cmd: [wrapper.command, ...wrapper.args],
        stdout: "pipe",
        stderr: "pipe",
      })
      if (result.exitCode !== 0) {
        const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : ""
        throw new Error(`Command failed (unsandboxed) with exit code ${result.exitCode}: ${stderr.trim()}`)
      }
      return {
        exitCode: result.exitCode,
        stdout: result.stdout ? new TextDecoder().decode(result.stdout) : "",
      }
    }

    // --- sandboxed path ---
    const tempPath = wrapper.tempPath
    try {
      const result = Bun.spawnSync({
        cmd: [wrapper.command, ...wrapper.args],
        stdout: "pipe",
        stderr: "pipe",
      })

      if (result.exitCode !== 0) {
        const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : ""
        throw new Error(`Sandbox command failed with exit code ${result.exitCode}: ${stderr.trim()}`)
      }

      return {
        exitCode: result.exitCode,
        stdout: result.stdout ? new TextDecoder().decode(result.stdout) : "",
      }
    } finally {
      // Clean up temp profile even on failure
      if (tempPath) {
        cleanupTemp(tempPath)
      }
    }
  }
}
