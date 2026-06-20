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
//   3. The shared executeAsync() function
//
// Design invariants:
//   - prepareWrapper writes a temp .sb profile; executeAsync cleans it in finally.
//   - Seatbelt uses allow-default for OS viability, then explicitly denies user-data roots
//     and re-allows the active workspace / controlled temp paths.
//   - Protected paths (deny file-write*) follow write-allow rules (last-match-wins).
//   - bwrap never --ro-bind /; only runtime roots + workspace + controlled tmp.
// ---------------------------------------------------------------------------

import {
  type PlatformInfo,
  type PrepareWrapperOpts,
  type PrepareLinuxWrapperOpts,
  type SeatbeltProfileOpts,
  type SandboxExecutionWrapper,
  type SandboxExecuteOpts,
  type SandboxExecuteResult,
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
  SandboxExecuteOpts,
  SandboxExecuteResult,
} from "./types"

// ------------------------------------------------------------------
// Imports from sibling modules
// ------------------------------------------------------------------

import { SandboxDetector } from "@/enforcement/sandbox-detector"
import { EnforcementError } from "@/enforcement/errors"
import { detectPlatform, isPlatformSupported as platformIsSupported } from "./detect"
import { platformInfo as getPlatformInfo } from "./platform"
import { MacBackend } from "./macos"
import { LinuxBackend } from "./linux"
import { WindowsBackend } from "./windows"
import { startDenialLogger, type DenialLoggerSession } from "./macos-diagnostics"

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
   * windows → Phase 3: synergy-sandbox.exe --config <tmpConfig> -- <command> <args...>
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
        // Phase 2: Linux dispatch delegates helper availability checks to
        // LinuxBackend.prepare(). No pre-checks — the backend handles its own
        // availability (helper path) or generates inline args (bwrap-inline-debug).
        // Convert PrepareWrapperOpts → PrepareLinuxWrapperOpts.
        const linuxOpts: PrepareLinuxWrapperOpts = {
          command: opts.command,
          args: opts.args,
          workspace: opts.workspace,
          sandboxMode: opts.sandboxMode,
          runtimeReadRoots: opts.runtimeReadRoots,
          extraReadRoots: opts.extraReadRoots,
          extraWritableRoots: opts.extraWritableRoots,
          forcePlatform: opts.forcePlatform,
          backend: opts.backend,
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
   * - --ro-bind for platform and runtime read roots
   * - Bind active workspace with --bind (read-write) or --ro-bind (read-only)
   * - Final args: bwrap <mounts> -- <command> <args...>
   */
  export function prepareLinuxWrapper(opts: PrepareLinuxWrapperOpts): SandboxExecutionWrapper {
    return LinuxBackend.prepare(opts)
  }

  // ----------------------------------------------------------------
  // Execution (shared, platform-agnostic async spawn)
  // ----------------------------------------------------------------

  /**
   * Environment variables allowed through the sandbox.
   * Never expose credential-bearing variables.
   */
  export const SANDBOX_ENV_ALLOWLIST = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SHELL",
    "TERM",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "BUN_INSTALL",
    "NODE_PATH",
    "npm_config_cache",
    "PYTHONPATH",
    "GIT_EXEC_PATH",
  ]

  function buildSandboxEnv(requestedEnv?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {}
    const processEnv = process.env

    for (const key of SANDBOX_ENV_ALLOWLIST) {
      const val = processEnv[key]
      if (val !== undefined) {
        env[key] = val
      }
    }

    // Explicitly requested env vars from the caller (e.g. approved tool paths)
    if (requestedEnv) {
      for (const [k, v] of Object.entries(requestedEnv)) {
        env[k] = v
      }
    }

    return env
  }

  export interface ExecuteAsyncResult {
    exitCode: number
    stdout: string
    stderr: string
    timedOut: boolean
    truncated: boolean
  }

  /**
   * Async spawn through the sandbox wrapper.
   *
   * Features:
   *   - Env allowlist: only safe env vars pass through
   *   - Timeout: SIGTERM → 2s grace → SIGKILL
   *   - Output cap: maxOutputBytes (default 1 MB); truncated set when exceeded
   *   - Signal: AbortSignal support
   *   - Temp profile cleanup in finally block
   *   - Throws EnforcementError.SandboxBlocked on sandbox denial detection
   *   - Otherwise returns structured result for non-zero exits
   */
  export async function executeAsync(
    wrapper: SandboxExecutionWrapper,
    opts: SandboxExecuteOpts,
  ): Promise<ExecuteAsyncResult> {
    if (wrapper.skipReason) {
      if (opts.fallbackPolicy === "deny") {
        throw new Error(`Sandbox required but unavailable: ${wrapper.skipReason}`)
      }
      // warn/allow: run unsandboxed with warning logged
    }

    const env = buildSandboxEnv(opts.env)
    const cwd = opts.cwd ?? process.cwd()

    const cmd: string[] = [wrapper.command, ...wrapper.args]

    const child = Bun.spawn({
      cmd,
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: null,
      onExit: () => {},
    })

    // ── macOS denial logger: capture sandboxd audit events ───────
    let denialSession: DenialLoggerSession | null = null
    if (wrapper.sandboxed) {
      const platform = detectPlatform()
      if (platform === "macos") {
        denialSession = startDenialLogger(child.pid)
      }
    }

    const outputChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    const reader = child.stdout.getReader()
    const errReader = child.stderr.getReader()

    const MAX_OUTPUT_BYTES = opts.maxOutputBytes ?? 1024 * 1024 // 1 MB default
    let totalBytes = 0
    let timedOut = false
    let truncated = false

    const readStream = async (
      r: ReadableStreamDefaultReader<Uint8Array>,
      collector: Buffer[],
      onChunk?: (chunk: Buffer) => void,
    ) => {
      while (true) {
        const { done, value } = await r.read()
        if (done) break
        if (onChunk) onChunk(Buffer.from(value))
        if (totalBytes + value.length > MAX_OUTPUT_BYTES) {
          collector.push(Buffer.from(value.slice(0, MAX_OUTPUT_BYTES - totalBytes)))
          truncated = true
          break
        }
        collector.push(Buffer.from(value))
        totalBytes += value.length
      }
    }

    const tempPath = wrapper.tempPath

    try {
      if (opts.signal) {
        const abort = () => {
          timedOut = true
          child.kill("SIGTERM")
          setTimeout(() => child.kill("SIGKILL"), 2000)
        }
        if (opts.signal.aborted) {
          abort()
        } else {
          opts.signal.addEventListener("abort", abort, { once: true })
        }
      }

      if (opts.timeoutMs && opts.timeoutMs > 0) {
        const timeout = setTimeout(() => {
          timedOut = true
          child.kill("SIGTERM")
          setTimeout(() => child.kill("SIGKILL"), 2000)
        }, opts.timeoutMs)

        await Promise.all([
          readStream(reader, outputChunks, opts.onStdout),
          readStream(errReader, stderrChunks, opts.onStderr),
          child.exited,
        ])
        clearTimeout(timeout)
      } else {
        await Promise.all([
          readStream(reader, outputChunks, opts.onStdout),
          readStream(errReader, stderrChunks, opts.onStderr),
          child.exited,
        ])
      }
    } catch (e) {
      child.kill("SIGKILL")
      throw e
    } finally {
      if (tempPath) {
        cleanupTemp(tempPath)
      }
    }

    const exitCode = child.exitCode ?? -1
    const stdout = Buffer.concat(outputChunks).toString("utf-8")
    const stderr = Buffer.concat(stderrChunks).toString("utf-8")

    // ── Stop macOS denial logger ─────────────────────────────────
    if (denialSession) {
      denialSession.stop()
    }

    // ── Sandbox denial detection ──────────────────────────────────
    // When the sandbox is active and the command fails, scan output
    // for OS-level permission denial patterns. On macOS, include
    // sandboxd audit events captured by the denial logger.
    if (wrapper.sandboxed && exitCode !== 0 && !timedOut) {
      let combinedOutput = stdout + stderr
      if (denialSession && denialSession.output.length > 0) {
        combinedOutput += "\n" + denialSession.output.join("\n")
      }
      const matches = SandboxDetector.scan(combinedOutput)
      if (matches.length > 0) {
        const info = platformInfo()
        const explanation = SandboxDetector.buildBlockExplanation(matches, {
          command: wrapper.command,
          backend: info.backend,
        })
        const message = explanation
          ? SandboxDetector.formatBlockExplanation(matches, {
              command: wrapper.command,
              backend: info.backend,
            })
          : SandboxDetector.explain(matches)
        throw new EnforcementError.SandboxBlocked(
          message,
          exitCode,
          matches[0]?.label ?? null,
          combinedOutput,
          explanation ?? undefined,
        )
      }
    }

    return {
      exitCode,
      stdout,
      stderr,
      timedOut,
      truncated,
    }
  }
  // ----------------------------------------------------------------
  // Execution (sync compatibility wrapper — Bun.spawnSync)
  // ----------------------------------------------------------------

  /**
   * Synchronous sandbox execution wrapper.
   *
   * This is a compatibility wrapper for code that requires sync execution.
   * Production code should prefer executeAsync() for timeout, signal,
   * and streaming support.
   *
   * Inherits the same fallback policy, env allowlist, temp cleanup,
   * and sandbox denial detection as the async version.
   */
  export function execute(
    wrapper: SandboxExecutionWrapper,
    opts?: Partial<Pick<SandboxExecuteOpts, "fallbackPolicy" | "env" | "cwd">>,
  ): ExecuteAsyncResult {
    const fallbackPolicy = opts?.fallbackPolicy ?? "warn"

    if (wrapper.skipReason) {
      if (fallbackPolicy === "deny") {
        throw new Error(`Sandbox execution denied: ${wrapper.skipReason}`)
      }
      // warn/allow: run unsandboxed
    }

    const env = buildSandboxEnv(opts?.env)
    const cwd = opts?.cwd ?? process.cwd()

    const cmd: string[] = [wrapper.command, ...wrapper.args]
    const { tempPath } = wrapper

    try {
      const result = Bun.spawnSync({
        cmd,
        cwd,
        env,
        stdout: "pipe",
        stderr: "pipe",
      })

      const exitCode = result.exitCode ?? -1
      const stdout = result.stdout ? new TextDecoder().decode(result.stdout) : ""
      const stderr = result.stderr ? new TextDecoder().decode(result.stderr) : ""

      // ── Sandbox denial detection ──────────────────────────────────
      // When the sandbox is active and the command fails, scan output
      // for OS-level permission denial patterns.
      if (wrapper.sandboxed && exitCode !== 0) {
        const combinedOutput = stdout + stderr
        const matches = SandboxDetector.scan(combinedOutput)
        if (matches.length > 0) {
          const info = platformInfo()
          const explanation = SandboxDetector.buildBlockExplanation(matches, {
            command: wrapper.command,
            backend: info.backend,
          })
          const message = explanation
            ? SandboxDetector.formatBlockExplanation(matches, {
                command: wrapper.command,
                backend: info.backend,
              })
            : SandboxDetector.explain(matches)
          throw new EnforcementError.SandboxBlocked(
            message,
            exitCode,
            matches[0]?.label ?? null,
            combinedOutput,
            explanation ?? undefined,
          )
        }
      }

      return {
        exitCode,
        stdout,
        stderr,
        timedOut: false,
        truncated: false,
      }
    } finally {
      if (tempPath) {
        cleanupTemp(tempPath)
      }
    }
  }
}
