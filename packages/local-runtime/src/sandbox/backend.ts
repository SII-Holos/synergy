import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
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
  type SandboxNetworkMode,
} from "@ericsanchezok/synergy-harness/sandbox/types"

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
} from "@ericsanchezok/synergy-harness/sandbox/types"

// ------------------------------------------------------------------
// Imports from sibling modules
// ------------------------------------------------------------------

import { SandboxDetector } from "../enforcement/sandbox-detector"
import { EnforcementError } from "@ericsanchezok/synergy-harness/enforcement/errors"
import { detectPlatform, isPlatformSupported as platformIsSupported } from "./detect"
import { platformInfo as getPlatformInfo } from "./platform"
import { MacBackend } from "./macos"
import { LinuxBackend } from "./linux"
import { WindowsBackend } from "./windows"
import { startDenialLogger, type DenialLoggerSession } from "./macos-diagnostics"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { sandboxWriteRoots } from "@ericsanchezok/synergy-harness/sandbox/types"
import { OwnedProcess } from "../process/owned-process"
import type { Readable } from "node:stream"
const log = Log.create({ service: "sandbox-backend" })

// ------------------------------------------------------------------
// SandboxBackend — unified public API
// ------------------------------------------------------------------

export namespace SandboxBackend {
  export const platformInfo = getPlatformInfo
  export const generateSeatbeltProfile = MacBackend.generateSeatbeltProfile
  export const cleanupTemp = MacBackend.cleanupTemp
  /**
   * Release the temporary resources a prepared wrapper owns.
   *
   * Authorization now follows containment, so a wrapper can be prepared for a
   * call that is then refused. This is the same release the execution path
   * performs in its `finally` block, exposed so the preparer can undo a
   * preparation it did not execute. Backends stage their compiled profile in
   * `tempPath`; a wrapper with no staged file has nothing to release.
   */
  export function cleanupWrapper(wrapper: SandboxExecutionWrapper): void {
    if (wrapper.tempPath) cleanupTemp(wrapper.tempPath)
  }

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
   * linux   → synergy-sandbox-linux --permission-profile <tmpConfig> -- <command> <args...>
   * windows → synergy-sandbox-windows.exe --permission-profile <tmpConfig> -- <command> <args...>
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
          protectedPaths: opts.protectedPaths,
          dataDenyRoots: opts.dataDenyRoots,
          networkMode: opts.networkMode,
          forcePlatform: opts.forcePlatform,
          backend: opts.backend,
          forceHelperPath: opts.forceHelperPath,
          forceHelperVerified: opts.forceHelperVerified,
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
   * - Reads follow the deny-list model: the helper declares "/" readable so
   *   the plan starts from `--ro-bind / /`, and credential paths are covered.
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
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "ComSpec",
    "COMSPEC",
    "PATHEXT",
    "BUN_INSTALL",
    "NODE_PATH",
    "npm_config_cache",
    "PYTHONPATH",
    "GIT_EXEC_PATH",
  ]

  /** Env var injected to tell the agent that network is unavailable. */
  export const NETWORK_DISABLED_ENV_VAR = "SYNERGY_SANDBOX_NETWORK_DISABLED"

  function buildSandboxEnv(
    requestedEnv?: Record<string, string>,
    networkMode?: SandboxNetworkMode,
  ): Record<string, string> {
    const env: Record<string, string> = {}
    const processEnv = RuntimeContext.current().host.env

    for (const key of SANDBOX_ENV_ALLOWLIST) {
      const val = processEnv[key]
      if (val !== undefined) {
        env[key] = val
      }
    }

    // Signal network unavailability to the child process when the
    // sandbox profile restricts or proxies network access.
    if (networkMode === "restricted" || networkMode === "proxy_only") {
      env[NETWORK_DISABLED_ENV_VAR] = "1"
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
   *   - Timeout: cancellable admission and bounded native process-tree shutdown
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
    using wrapperCleanup = { [Symbol.dispose]: () => cleanupWrapper(wrapper) }
    if (wrapper.skipReason && opts.fallbackPolicy === "deny")
      throw new Error(`Sandbox required but unavailable: ${wrapper.skipReason}`)
    const limit = opts.maxOutputBytes ?? 1024 * 1024
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid sandbox output bound")
    const controller = new AbortController()
    let timedOut = false
    const interrupt = (reason?: unknown) => {
      timedOut = true
      controller.abort(reason)
    }
    const abort = () => interrupt(opts.signal?.reason)
    opts.signal?.addEventListener("abort", abort, { once: true })
    if (opts.signal?.aborted) abort()
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => interrupt(new DOMException("Sandbox execution timed out", "TimeoutError")), opts.timeoutMs)
        : undefined
    const outputChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let totalBytes = 0
    let truncated = false
    let lease: WorkspaceAccess.Lease | undefined
    let owned: Awaited<ReturnType<typeof OwnedProcess.prepare>> | undefined
    let exitCode = -1
    let denialSession: DenialLoggerSession | null = null
    using denialCleanup = { [Symbol.dispose]: () => denialSession?.stop() }
    const reads: Promise<void>[] = []
    const readStream = async (stream: Readable, collector: Buffer[], onChunk?: (chunk: Buffer) => void) => {
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        onChunk?.(chunk)
        const retained = Math.min(chunk.length, limit - totalBytes)
        if (retained) collector.push(Buffer.from(chunk.subarray(0, retained)))
        totalBytes += retained
        if (retained < chunk.length) truncated = true
      }
    }
    const stop = () => {
      void owned?.stop().catch(() => {})
    }
    controller.signal.addEventListener("abort", stop, { once: true })
    try {
      lease = await WorkspaceAccess.process(sandboxWriteRoots(wrapper), controller.signal)
      if (wrapper.sandboxed && detectPlatform() === "macos") denialSession = startDenialLogger()
      owned = await OwnedProcess.prepare({
        command: wrapper.command,
        args: wrapper.args,
        cwd: opts.cwd ?? process.cwd(),
        env: buildSandboxEnv(opts.env, opts.networkMode),
        lease,
        signal: controller.signal,
      })
      reads.push(
        readStream(owned.child.stdout, outputChunks, opts.onStdout),
        readStream(owned.child.stderr, stderrChunks, opts.onStderr),
      )
      for (const read of reads) void read.catch(() => {})
      await owned.activate()
      owned.child.stdin.end()
      denialSession?.adoptPid(owned.child.pid!)
      await opts.after_spawn?.(owned.child.pid!)
      await Promise.all([...reads, owned.completion])
      exitCode = owned.child.exitCode ?? -1
    } catch (error) {
      if (!controller.signal.aborted) throw error
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener("abort", abort)
      controller.signal.removeEventListener("abort", stop)
      if (owned) await owned.stop()
      else await lease?.release()
      await Promise.allSettled(reads)
    }

    const stdout = Buffer.concat(outputChunks).toString("utf-8")
    const stderr = Buffer.concat(stderrChunks).toString("utf-8")

    // ── Stop macOS denial logger ─────────────────────────────────
    // Audit records trail the child by a short interval, so give them a
    // bounded window before the stream is closed.
    if (denialSession) {
      await denialSession.flush()
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
    opts?: Partial<Pick<SandboxExecuteOpts, "fallbackPolicy" | "env" | "cwd" | "networkMode">>,
  ): ExecuteAsyncResult {
    const fallbackPolicy = opts?.fallbackPolicy ?? "warn"

    if (wrapper.skipReason) {
      if (fallbackPolicy === "deny") {
        throw new Error(`Sandbox execution denied: ${wrapper.skipReason}`)
      }
      // warn/allow: run unsandboxed
    }

    const env = buildSandboxEnv(opts?.env, opts?.networkMode)
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
