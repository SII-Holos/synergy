import { Log } from "@/util/log"
import { recordEvent } from "../plugin/audit.js"
import type { PluginToHost, IsolatedPluginInputData } from "./protocol.js"
import { resolveRuntimeMode } from "./mode-resolver.js"
import { spawnPluginProcess, type HostBridgeHandler } from "./process-host.js"
import { spawnPluginWorker } from "./worker-host.js"
import { Worker } from "node:worker_threads"
import { PluginRuntimeError, classifyRuntimeExit } from "./errors.js"
import { startHeartbeatMonitor, enforceStartupTimeout, DEFAULT_LIMITS, pushWarning } from "./health.js"
import { ConcurrencyLimiter, startMemoryMonitor, LogRateLimiter } from "./resource-limits.js"
import { readRuntimeState } from "./state-persist.js"
import { writeRuntimeState } from "./state-persist.js"
import { createBridgeEnforcementHandler } from "./bridge-enforcement.js"
import { getApproval } from "../plugin/consent/approval-store.js"
import type { PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"
import * as ManifestReader from "../plugin/manifest-reader"
const log = Log.create({ service: "plugin-runtime.supervisor" })
import { PluginLogBuffer } from "./logs.js"

// === Types ===

export type RuntimeMode = "in-process" | "worker" | "process"

export type RuntimeState = "starting" | "ready" | "unhealthy" | "stopped" | "crashed"
export type RuntimeWarningType =
  | "capability_denied"
  | "memory_limit_exceeded"
  | "log_rate_limited"
  | "heartbeat_missed"
  | "startup_timeout"
  | "worker_error"
  | "spawn_failed"

export interface RuntimeWarning {
  type: RuntimeWarningType
  message: string
  at: number
}

export interface RuntimeEntry {
  pluginId: string
  mode: RuntimeMode
  runtimeDecision?: string
  pid?: number
  state: RuntimeState
  restarts: number
  lastHeartbeatAt?: number
  memoryMb?: number
  startedAt?: number
  lastError?: string
  warnings: RuntimeWarning[]
  process?: Bun.Subprocess
  worker?: Worker
  concurrencyLimiter?: ConcurrencyLimiter
  memoryMonitor?: { stop: () => void }
  logRateLimiter?: LogRateLimiter
}

// === Heartbeat monitors ===

const heartbeatMonitors = new Map<string, { stop: () => void }>()

function stopHeartbeatMonitor(pluginId: string): void {
  const monitor = heartbeatMonitors.get(pluginId)
  if (monitor) {
    monitor.stop()
    heartbeatMonitors.delete(pluginId)
  }
}
// === Registry ===

function saveState(): void {
  void writeRuntimeState(Array.from(runtimeRegistry.values()))
}
const runtimeRegistry = new Map<string, RuntimeEntry>()

// Shared log buffer — all host implementations append log entries here
const logBuffer = new PluginLogBuffer()

export function getLogBuffer(): PluginLogBuffer {
  return logBuffer
}

export function getRuntime(pluginId: string): RuntimeEntry | undefined {
  return runtimeRegistry.get(pluginId)
}

export function getAllRuntimes(): RuntimeEntry[] {
  return Array.from(runtimeRegistry.values())
}

export function getRuntimeState(pluginId: string): RuntimeState {
  return runtimeRegistry.get(pluginId)?.state ?? "stopped"
}

export async function restoreRuntimeState(): Promise<void> {
  const savedState = await readRuntimeState()
  for (const persisted of savedState) {
    const entry: RuntimeEntry = {
      pluginId: persisted.pluginId,
      mode: persisted.mode as RuntimeMode,
      pid: persisted.pid,
      state: persisted.state,
      restarts: persisted.restarts,
      lastHeartbeatAt: persisted.lastHeartbeatAt,
      startedAt: persisted.startedAt,
      lastError: persisted.lastError,
      warnings: [],
    }
    runtimeRegistry.set(persisted.pluginId, entry)
  }
  if (savedState.length > 0) {
    log.info("restored runtime state", { count: savedState.length })
  }
}

// === Lifecycle ===

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 10_000

export async function startRuntime(
  pluginId: string,
  options: {
    mode?: RuntimeMode
    entryPath: string
    pluginDir: string
    scope?: import("../scope/types.js").Info
    serverUrl?: string
  },
): Promise<RuntimeEntry> {
  const existing = runtimeRegistry.get(pluginId)
  if (existing && existing.state !== "stopped" && existing.state !== "crashed") {
    log.warn("plugin already running", { pluginId, state: existing.state })
    return existing
  }

  // Fix 4: increment restarts if restarting from crashed/stopped
  const restarts =
    existing && (existing.state === "crashed" || existing.state === "stopped")
      ? existing.restarts + 1
      : existing
        ? existing.restarts
        : 0

  // Read manifest for runtime preferences (mode, resources)
  let manifest: PluginManifestType | null = null
  try {
    manifest = await ManifestReader.read(options.pluginDir)
  } catch {
    // Manifest may be missing or invalid; fall through with defaults
  }
  // Resolve runtime mode: caller wins, then resolveRuntimeMode, then default
  let runtimeDecision: string
  let resolvedMode: RuntimeMode
  if (options.mode) {
    resolvedMode = options.mode
    runtimeDecision = `caller-override:${resolvedMode}`
  } else {
    resolvedMode = resolveRuntimeMode({
      source: "npm", // actual source is resolved in install; runtime defaults to npm
      manifestMode: manifest?.runtime?.mode,
      devMode: false,
      userTrusted: false,
      risk: "low",
    })
    runtimeDecision = `policy:${resolvedMode}`
  }

  // Resolve resource limits: manifest resources overlay DEFAULT_LIMITS
  const manifestResources = manifest?.runtime?.resources
  const resolvedStartupTimeoutMs = manifestResources?.startupTimeoutMs ?? DEFAULT_LIMITS.STARTUP_TIMEOUT_MS

  const entry: RuntimeEntry = {
    pluginId,
    mode: resolvedMode,
    runtimeDecision,
    state: "starting",
    restarts,
    startedAt: Date.now(),
    warnings: [],
  }
  runtimeRegistry.set(pluginId, entry)

  if (resolvedMode === "in-process") {
    log.info("plugin registered in-process", { pluginId })
    entry.state = "ready"
    saveState()

    // Audit: runtime started
    void recordEvent({ pluginId: entry.pluginId, type: "runtime_started", details: { mode: resolvedMode } })
    return entry
  }

  if (resolvedMode === "worker") {
    // worker mode — delegate to spawnPluginWorker for Worker lifecycle
    try {
      const scope =
        options.scope ??
        ({
          id: "global",
          type: "global" as const,
          directory: options.pluginDir,
          worktree: options.pluginDir,
          time: { created: 0, updated: 0 },
          sandboxes: [],
        } as IsolatedPluginInputData["scope"])
      const serverUrl = options.serverUrl ?? "http://localhost:3000"

      const input: IsolatedPluginInputData = {
        pluginId,
        pluginDir: options.pluginDir,
        directory: scope.directory,
        scope,
        serverUrl,
      }

      const spawned = await spawnPluginWorker({
        pluginId,
        pluginDir: options.pluginDir,
        entryPath: options.entryPath,
        input,
        logBuffer,
      })

      entry.worker = spawned.worker
      entry.pid = spawned.worker.threadId

      spawned.onMessage((msg: PluginToHost) => {
        if (msg.type === "heartbeat") {
          entry.lastHeartbeatAt = Date.now()
        }
        if (msg.type === "ready") {
          entry.state = "ready"
          log.info("plugin ready", { pluginId })
        }
      })

      spawned.worker.on("error", (err: Error) => {
        pushWarning(pluginId, "worker_error", err.message)
        const pluginErr = new PluginRuntimeError(pluginId, "worker_error", err.message, { cause: err })
        log.error("worker error", { pluginId, error: pluginErr.message })
        entry.state = "crashed"
        entry.lastError = pluginErr.toString()
        saveState()
        void recordEvent({
          pluginId,
          type: "runtime_crashed",
          details: { reason: "worker_error", error: pluginErr.message },
        })
      })

      spawned.worker.on("exit", (exitCode: number) => {
        if (entry.state !== "stopped") {
          const classification = classifyRuntimeExit(exitCode, null)
          entry.state = classification === "normal" ? "stopped" : "crashed"
          if (classification !== "normal") {
            entry.lastError = `Worker exited with code ${exitCode} (${classification})`
          }
          entry.worker = undefined
          entry.pid = undefined
          saveState()
        }
      })

      // Startup timeout enforcement
      enforceStartupTimeout(pluginId, entry.startedAt!, resolvedStartupTimeoutMs, (timedOutPluginId) => {
        log.error("startup timeout", { pluginId: timedOutPluginId })
        const e = runtimeRegistry.get(timedOutPluginId)
        if (e && e.state === "starting") {
          pushWarning(timedOutPluginId, "startup_timeout", `Startup timed out after ${resolvedStartupTimeoutMs}ms`)
          e.state = "crashed"
          e.lastError = "Startup timeout"
          forceStop(e)
          saveState()
          void recordEvent({
            pluginId: timedOutPluginId,
            type: "runtime_crashed",
            details: { reason: "startup_timeout" },
          })
        }
      })

      log.info("plugin worker spawned", { pluginId, threadId: spawned.worker.threadId })

      // Audit: runtime started
      void recordEvent({ pluginId, type: "runtime_started", details: { mode: resolvedMode } })
      return entry
    } catch (err: any) {
      pushWarning(pluginId, "spawn_failed", `Worker spawn failed: ${err.message}`)
      const pluginErr = new PluginRuntimeError(pluginId, "spawn_failed", `Worker spawn failed: ${err.message}`, {
        cause: err,
      })
      log.error("failed to spawn plugin worker", { pluginId, error: pluginErr.message })
      entry.state = "crashed"
      entry.lastError = pluginErr.toString()
      saveState()
      void recordEvent({
        pluginId,
        type: "runtime_crashed",
        details: { reason: "spawn_failed", error: pluginErr.message },
      })
      return entry
    }
  }

  // process mode — Fix 3: spawn real process via spawnPluginProcess
  try {
    const scope =
      options.scope ??
      ({
        id: "global",
        type: "global" as const,
        directory: options.pluginDir,
        worktree: options.pluginDir,
        time: { created: 0, updated: 0 },
        sandboxes: [],
      } as IsolatedPluginInputData["scope"])
    const serverUrl = options.serverUrl ?? "http://localhost:3000"

    const input: IsolatedPluginInputData = {
      pluginId,
      pluginDir: options.pluginDir,
      directory: scope.directory,
      scope,
      serverUrl,
    }
    // Resolve approved capabilities and create bridge enforcement handler
    const approval = await getApproval(pluginId)
    const approvedCapabilities = approval?.approvedCapabilities ?? []
    const enforcer = createBridgeEnforcementHandler(pluginId, approvedCapabilities)
    const enforcementHandler: HostBridgeHandler = async (_requestId, method, params) => {
      const result = enforcer(method, params)
      if (!result.allowed) {
        // Push persistent warning and audit
        pushWarning(
          pluginId,
          "capability_denied",
          `Capability "${method}" denied: ${result.reason ?? "unknown reason"}`,
        )
        void recordEvent({ pluginId, type: "capability_denied", details: { method, reason: result.reason } })
        throw new Error(result.reason ?? "Bridge request denied by enforcement")
      }
      // Bridge method execution will be wired by the plugin runtime system
      return undefined
    }

    const spawned = await spawnPluginProcess({
      pluginId,
      pluginDir: options.pluginDir,
      entryPath: options.entryPath,
      input,
      hostBridgeHandler: enforcementHandler,
      logBuffer,
    })

    entry.process = spawned.process
    entry.pid = spawned.process.pid

    // Fix 1: wire heartbeat updates from plugin messages
    spawned.onMessage((msg: PluginToHost) => {
      if (msg.type === "heartbeat") {
        entry.lastHeartbeatAt = Date.now()
      }
      if (msg.type === "ready") {
        entry.state = "ready"
        log.info("plugin ready", { pluginId })
      }
    })

    // Fix 6: start heartbeat monitor with unhealthy transition
    stopHeartbeatMonitor(pluginId)
    const monitor = startHeartbeatMonitor(pluginId, (missedPluginId, missCount) => {
      log.warn("heartbeat missed, marking unhealthy", { pluginId: missedPluginId, missCount })
      const e = runtimeRegistry.get(missedPluginId)
      if (e) {
        pushWarning(missedPluginId, "heartbeat_missed", `Missed ${missCount} heartbeat(s)`)
        e.state = "unhealthy"
        e.lastError = `Missed ${missCount} heartbeats`
        saveState()
        if (missCount >= DEFAULT_LIMITS.HEARTBEAT_MISSES_BEFORE_KILL) {
          log.error("killing plugin after heartbeat misses exceeded limit", {
            pluginId: missedPluginId,
            missCount,
            limit: DEFAULT_LIMITS.HEARTBEAT_MISSES_BEFORE_KILL,
          })
          killRuntime(missedPluginId)
        }
      }
    })
    heartbeatMonitors.set(pluginId, monitor)

    enforceStartupTimeout(pluginId, entry.startedAt!, resolvedStartupTimeoutMs, (timedOutPluginId) => {
      log.error("startup timeout", { pluginId: timedOutPluginId })
      const e = runtimeRegistry.get(timedOutPluginId)
      if (e && e.state === "starting") {
        pushWarning(timedOutPluginId, "startup_timeout", `Startup timed out after ${resolvedStartupTimeoutMs}ms`)
        e.state = "crashed"
        e.lastError = "Startup timeout"
        forceStop(e)
        saveState()
        void recordEvent({
          pluginId: timedOutPluginId,
          type: "runtime_crashed",
          details: { reason: "startup_timeout" },
        })
      }
    })

    log.info("plugin process spawned", { pluginId, pid: entry.pid })

    // Resource limits
    const concurrency = new ConcurrencyLimiter(DEFAULT_LIMITS.CONCURRENT_REQUESTS)
    entry.concurrencyLimiter = concurrency

    const memoryMonitor = startMemoryMonitor(
      pluginId,
      entry.pid!,
      DEFAULT_LIMITS.MEMORY_MB,
      10_000,
      (exceededPluginId, currentMb, maxMb) => {
        pushWarning(exceededPluginId, "memory_limit_exceeded", `Memory ${currentMb}MB exceeded limit ${maxMb}MB`)
        log.warn(`Plugin ${exceededPluginId} memory exceeded: ${currentMb}MB / ${maxMb}MB — killing`, {
          pluginId: exceededPluginId,
          currentMb,
          maxMb,
        })
        killRuntime(exceededPluginId)
      },
    )
    entry.memoryMonitor = memoryMonitor

    const logLimiter = new LogRateLimiter(DEFAULT_LIMITS.MAX_LOG_BYTES_PER_MINUTE)
    entry.logRateLimiter = logLimiter

    // Audit: runtime started
    void recordEvent({ pluginId, type: "runtime_started", details: { mode: resolvedMode, pid: entry.pid } })
    return entry
  } catch (err: any) {
    pushWarning(pluginId, "spawn_failed", `Spawn failed: ${err.message}`)
    const pluginErr = new PluginRuntimeError(pluginId, "spawn_failed", `Spawn failed: ${err.message}`, {
      cause: err,
    })
    log.error("failed to spawn plugin process", { pluginId, error: pluginErr.message })
    entry.state = "crashed"
    entry.lastError = pluginErr.toString()
    saveState()
    void recordEvent({
      pluginId,
      type: "runtime_crashed",
      details: { reason: "spawn_failed", error: pluginErr.message },
    })
    return entry
  }
}

export async function stopRuntime(pluginId: string, graceful: boolean): Promise<void> {
  const entry = runtimeRegistry.get(pluginId)
  if (!entry) {
    log.warn("stopRuntime called for unknown plugin", { pluginId })
    return
  }

  if (entry.state === "stopped") return

  stopHeartbeatMonitor(pluginId)
  entry.memoryMonitor?.stop()

  if (entry.worker) {
    // Workers use terminate() — no graceful shutdown protocol yet
    forceStop(entry)
  } else if (graceful && entry.process) {
    log.info("sending shutdown to plugin", { pluginId })
    // TODO: Send "shutdown" message over IPC
    const timeout = setTimeout(() => {
      log.warn("graceful shutdown timed out, force killing", { pluginId })
      forceStop(entry)
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS)

    // Wait for process to exit naturally
    try {
      await entry.process.exited
    } catch {
      // Process already dead
    }
    clearTimeout(timeout)
  } else {
    forceStop(entry)
  }

  entry.state = "stopped"
  entry.process = undefined
  entry.worker = undefined
  entry.pid = undefined
  runtimeRegistry.set(pluginId, entry)
  saveState()
  log.info("plugin stopped", { pluginId })
}

function forceStop(entry: RuntimeEntry): void {
  if (entry.worker) {
    try {
      entry.worker.terminate()
    } catch {
      // Worker may already be dead
    }
    entry.worker = undefined
  }
  if (entry.process) {
    try {
      entry.process.kill("SIGKILL")
    } catch {
      // Process may already be dead
    }
    entry.process = undefined
  }
}

export async function reloadRuntime(pluginId: string): Promise<RuntimeEntry> {
  const entry = runtimeRegistry.get(pluginId)
  if (!entry) {
    throw new Error(`Cannot reload unknown plugin: ${pluginId}`)
  }

  log.info("reloading plugin", { pluginId })
  await stopRuntime(pluginId, true)

  return startRuntime(pluginId, {
    mode: entry.mode,
    entryPath: "", // caller must re-resolve
    pluginDir: "", // caller must re-resolve
  })
}

export async function killRuntime(pluginId: string): Promise<void> {
  const entry = runtimeRegistry.get(pluginId)
  if (!entry) {
    log.warn("killRuntime called for unknown plugin", { pluginId })
    return
  }

  if (entry.state === "stopped") return

  stopHeartbeatMonitor(pluginId)
  entry.memoryMonitor?.stop()
  forceStop(entry)
  entry.state = "stopped"
  entry.process = undefined
  entry.worker = undefined
  entry.pid = undefined
  runtimeRegistry.set(pluginId, entry)
  saveState()
  // Audit: runtime killed
  void recordEvent({ pluginId, type: "runtime_killed", details: { reason: "explicit_kill" } })
  log.info("plugin killed", { pluginId })
}
