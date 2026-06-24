import { Log } from "@/util/log"
import { recordEvent } from "../plugin/audit.js"
import type { IsolatedPluginInputData, HostBridgeHandler } from "./protocol.js"
import { resolveRuntimeMode } from "./mode-resolver.js"
import { spawnPluginProcess } from "./process-host.js"
import { spawnPluginWorker } from "./worker-host.js"
import type { Worker } from "node:worker_threads"
import { PluginRuntimeError } from "./errors.js"
import { DEFAULT_LIMITS } from "./health.js"
import type { RuntimeHealth } from "./health.js"
import { ConcurrencyLimiter, startMemoryMonitor, LogRateLimiter } from "./resource-limits.js"
import { writeRuntimeState, readRuntimeState } from "./state-persist.js"
import { createBridgeEnforcementHandler } from "./bridge-enforcement.js"
import { executeBridgeMethod } from "./bridge-handlers.js"
import { getApproval } from "../plugin/consent/approval-store.js"
import type { PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"
import * as ManifestReader from "../plugin/manifest-reader"
import { PluginLogBuffer } from "./logs.js"
import {
  RuntimeRegistry,
  defaultRuntimeRegistry,
  type RuntimeEntry,
  type RuntimeMode,
  type RuntimeState,
  type PersistedRuntimeEntry,
} from "./registry.js"

import type { PluginSource } from "../plugin/trust.js"

const log = Log.create({ service: "plugin-runtime.supervisor" })

// Re-export types for backward compatibility (consumers import from supervisor)
export type { RuntimeMode, RuntimeState, RuntimeEntry, RuntimeHealth, PersistedRuntimeEntry }

// === Persistence interface ===

export interface RuntimeStatePersistence {
  save(entries: RuntimeEntry[]): Promise<void>
  load(): Promise<PersistedRuntimeEntry[]>
}

const defaultPersistence: RuntimeStatePersistence = {
  save: (entries) => writeRuntimeState(entries),
  load: () => readRuntimeState(),
}

// === Start options ===

export interface StartRuntimeOptions {
  mode?: RuntimeMode
  source?: PluginSource
  entryPath: string
  pluginDir: string
  scope?: import("../scope/types.js").Info
  serverUrl?: string
}

// === PluginRuntimeSupervisor ===

export class PluginRuntimeSupervisor {
  #registry: RuntimeRegistry
  #logBuffer: PluginLogBuffer
  #persist: RuntimeStatePersistence
  #heartbeatMonitors = new Map<string, { stop: () => void }>()

  constructor(deps: { registry: RuntimeRegistry; logs: PluginLogBuffer; persist?: RuntimeStatePersistence }) {
    this.#registry = deps.registry
    this.#logBuffer = deps.logs
    this.#persist = deps.persist ?? defaultPersistence
  }

  // === Heartbeat monitors (private) ===

  #stopHeartbeatMonitor(pluginId: string): void {
    const monitor = this.#heartbeatMonitors.get(pluginId)
    if (monitor) {
      monitor.stop()
      this.#heartbeatMonitors.delete(pluginId)
    }
  }

  #startHeartbeatMonitor(
    pluginId: string,
    onMissedHeartbeat: (pluginId: string, missCount: number) => void,
  ): { stop: () => void } {
    let missCount = 0

    const interval = setInterval(() => {
      const entry = this.#registry.get(pluginId)
      if (!entry) {
        clearInterval(interval)
        return
      }

      const now = Date.now()
      const lastHeartbeatAt = entry.lastHeartbeatAt ?? 0

      if (now - lastHeartbeatAt > DEFAULT_LIMITS.HEARTBEAT_INTERVAL_MS) {
        missCount++
        if (missCount >= DEFAULT_LIMITS.HEARTBEAT_MISSES_BEFORE_KILL) {
          clearInterval(interval)
          onMissedHeartbeat(pluginId, missCount)
        }
      } else {
        missCount = 0
      }
    }, DEFAULT_LIMITS.HEARTBEAT_INTERVAL_MS)

    return { stop: () => clearInterval(interval) }
  }

  #enforceStartupTimeout(
    pluginId: string,
    startedAt: number,
    timeoutMs: number,
    onTimeout: (pluginId: string) => void,
  ): { clear: () => void } {
    const timer = setTimeout(() => {
      const entry = this.#registry.get(pluginId)
      if (!entry) return

      if (entry.state === "starting") {
        onTimeout(pluginId)
      }
    }, timeoutMs)

    return { clear: () => clearTimeout(timer) }
  }

  // === State persistence (private) ===

  #saveState(): void {
    void this.#persist.save(this.#registry.list())
  }

  async #createBridgeHandler(pluginId: string, pluginDir: string): Promise<HostBridgeHandler> {
    const approval = await getApproval(pluginId)
    const approvedCapabilities = approval?.approvedCapabilities ?? []
    const enforcer = createBridgeEnforcementHandler(pluginId, approvedCapabilities)
    return async (_requestId, method, params) => {
      const result = enforcer(method, params)
      if (!result.allowed) {
        this.#registry.pushWarning(
          pluginId,
          "capability_denied",
          `Capability "${method}" denied: ${result.reason ?? "unknown reason"}`,
        )
        void recordEvent({ pluginId, type: "capability_denied", details: { method, reason: result.reason } })
        throw new Error(result.reason ?? "Bridge request denied by enforcement")
      }
      return executeBridgeMethod({ pluginId, pluginDir, method, params })
    }
  }

  // === Force stop (private) ===

  #forceStop(entry: RuntimeEntry): void {
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

  // === Public query methods ===

  getRuntime(pluginId: string): RuntimeEntry | undefined {
    return this.#registry.get(pluginId)
  }

  getAllRuntimes(): RuntimeEntry[] {
    return this.#registry.list()
  }

  getRuntimeState(pluginId: string): RuntimeState {
    return this.#registry.get(pluginId)?.state ?? "stopped"
  }

  getRuntimeHealth(pluginId: string): RuntimeHealth | null {
    return this.#registry.getHealth(pluginId)
  }

  getLogBuffer(): PluginLogBuffer {
    return this.#logBuffer
  }

  async restoreRuntimeState(): Promise<void> {
    const savedState = await this.#persist.load()
    this.#registry.restore(savedState)
    if (savedState.length > 0) {
      log.info("restored runtime state", { count: savedState.length })
    }
  }

  // === Lifecycle methods ===

  async start(pluginId: string, options: StartRuntimeOptions): Promise<RuntimeEntry> {
    const existing = this.#registry.get(pluginId)
    if (existing && existing.state !== "stopped" && existing.state !== "crashed") {
      log.warn("plugin already running", { pluginId, state: existing.state })
      return existing
    }

    // Reset or increment restart counter when restarting
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
        source: options.source ?? "npm",
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
      entryPath: options.entryPath,
      pluginDir: options.pluginDir,
      source: options.source,
      serverUrl: options.serverUrl,
      state: "starting",
      restarts,
      startedAt: Date.now(),
      warnings: [],
    }
    this.#registry.set(entry)

    if (resolvedMode === "in-process") {
      log.info("plugin registered in-process", { pluginId })
      entry.state = "ready"
      this.#saveState()

      void recordEvent({ pluginId: entry.pluginId, type: "runtime_started", details: { mode: resolvedMode } })
      return entry
    }

    if (resolvedMode === "worker") {
      return this.#startWorker(pluginId, entry, options, resolvedMode, resolvedStartupTimeoutMs)
    }

    // process mode
    return this.#startProcess(pluginId, entry, options, resolvedMode, resolvedStartupTimeoutMs)
  }

  async #startWorker(
    pluginId: string,
    entry: RuntimeEntry,
    options: StartRuntimeOptions,
    resolvedMode: RuntimeMode,
    resolvedStartupTimeoutMs: number,
  ): Promise<RuntimeEntry> {
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
      const enforcementHandler = await this.#createBridgeHandler(pluginId, options.pluginDir)
      const concurrency = new ConcurrencyLimiter(DEFAULT_LIMITS.CONCURRENT_REQUESTS)
      entry.concurrencyLimiter = concurrency
      const logLimiter = new LogRateLimiter(DEFAULT_LIMITS.MAX_LOG_BYTES_PER_MINUTE)
      entry.logRateLimiter = logLimiter

      const spawned = await spawnPluginWorker({
        pluginId,
        pluginDir: options.pluginDir,
        entryPath: options.entryPath,
        input,
        hostBridgeHandler: enforcementHandler,
        concurrencyLimiter: concurrency,
        onHeartbeat: () => {
          entry.lastHeartbeatAt = Date.now()
        },
        onReady: () => {
          entry.state = "ready"
          log.info("plugin ready", { pluginId })
        },
        onLog: (logEntry) => {
          if (entry.logRateLimiter && !entry.logRateLimiter.allow(logEntry.message.length)) {
            this.#registry.pushWarning(pluginId, "log_rate_limited", "Log rate limit exceeded — message dropped")
            return
          }
          this.#logBuffer.append(pluginId, logEntry)
        },
        onError: (pluginErr) => {
          this.#registry.pushWarning(pluginId, "worker_error", pluginErr.message)
          log.error("worker error", { pluginId, error: pluginErr.message })
          entry.state = "crashed"
          entry.lastError = pluginErr.toString()
          this.#saveState()
          void recordEvent({
            pluginId,
            type: "runtime_crashed",
            details: { reason: "worker_error", error: pluginErr.message },
          })
        },
        onExit: (exit) => {
          if (entry.state !== "stopped") {
            const classification = exit.classification
            entry.state = classification === "normal" ? "stopped" : "crashed"
            if (classification !== "normal") {
              entry.lastError = `Worker exited with code ${exit.exitCode} (${classification})`
            }
            entry.worker = undefined
            entry.pid = undefined
            this.#saveState()
          }
        },
      })

      entry.worker = spawned.worker
      entry.pid = spawned.worker.threadId

      this.#enforceStartupTimeout(pluginId, entry.startedAt!, resolvedStartupTimeoutMs, (timedOutPluginId) => {
        log.error("startup timeout", { pluginId: timedOutPluginId })
        const e = this.#registry.get(timedOutPluginId)
        if (e && e.state === "starting") {
          this.#registry.pushWarning(
            timedOutPluginId,
            "startup_timeout",
            `Startup timed out after ${resolvedStartupTimeoutMs}ms`,
          )
          e.state = "crashed"
          e.lastError = "Startup timeout"
          this.#forceStop(e)
          this.#saveState()
          void recordEvent({
            pluginId: timedOutPluginId,
            type: "runtime_crashed",
            details: { reason: "startup_timeout" },
          })
        }
      })

      log.info("plugin worker spawned", { pluginId, threadId: spawned.worker.threadId })

      void recordEvent({ pluginId, type: "runtime_started", details: { mode: resolvedMode } })
      return entry
    } catch (err: any) {
      this.#registry.pushWarning(pluginId, "spawn_failed", `Worker spawn failed: ${err.message}`)
      const pluginErr = new PluginRuntimeError(pluginId, "spawn_failed", `Worker spawn failed: ${err.message}`, {
        cause: err,
      })
      log.error("failed to spawn plugin worker", { pluginId, error: pluginErr.message })
      entry.state = "crashed"
      entry.lastError = pluginErr.toString()
      this.#saveState()
      void recordEvent({
        pluginId,
        type: "runtime_crashed",
        details: { reason: "spawn_failed", error: pluginErr.message },
      })
      return entry
    }
  }

  async #startProcess(
    pluginId: string,
    entry: RuntimeEntry,
    options: StartRuntimeOptions,
    resolvedMode: RuntimeMode,
    resolvedStartupTimeoutMs: number,
  ): Promise<RuntimeEntry> {
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

      const enforcementHandler = await this.#createBridgeHandler(pluginId, options.pluginDir)

      // Create resource limiters BEFORE spawn so callbacks can reference them
      const concurrency = new ConcurrencyLimiter(DEFAULT_LIMITS.CONCURRENT_REQUESTS)
      entry.concurrencyLimiter = concurrency
      const logLimiter = new LogRateLimiter(DEFAULT_LIMITS.MAX_LOG_BYTES_PER_MINUTE)
      entry.logRateLimiter = logLimiter

      const spawned = await spawnPluginProcess({
        pluginId,
        pluginDir: options.pluginDir,
        entryPath: options.entryPath,
        input,
        hostBridgeHandler: enforcementHandler,
        concurrencyLimiter: concurrency,
        onHeartbeat: () => {
          entry.lastHeartbeatAt = Date.now()
        },
        onReady: () => {
          entry.state = "ready"
          log.info("plugin ready", { pluginId })
        },
        onLog: (logEntry) => {
          if (entry.logRateLimiter && !entry.logRateLimiter.allow(logEntry.message.length)) {
            this.#registry.pushWarning(pluginId, "log_rate_limited", "Log rate limit exceeded — message dropped")
            return
          }
          this.#logBuffer.append(pluginId, logEntry)
        },
        onExit: (exit) => {
          if (entry.state !== "stopped") {
            entry.state = exit.classification === "normal" ? "stopped" : "crashed"
            if (exit.classification !== "normal") {
              entry.lastError = `Process exited with code ${exit.exitCode} (${exit.classification})`
            }
            entry.process = undefined
            entry.pid = undefined
            this.#stopHeartbeatMonitor(pluginId)
            this.#saveState()
          }
        },
      })

      entry.process = spawned.process
      entry.pid = spawned.process.pid

      // Start heartbeat monitor
      this.#stopHeartbeatMonitor(pluginId)
      const monitor = this.#startHeartbeatMonitor(pluginId, (missedPluginId, missCount) => {
        log.warn("heartbeat missed, marking unhealthy", { pluginId: missedPluginId, missCount })
        const e = this.#registry.get(missedPluginId)
        if (e) {
          this.#registry.pushWarning(missedPluginId, "heartbeat_missed", `Missed ${missCount} heartbeat(s)`)
          e.state = "unhealthy"
          e.lastError = `Missed ${missCount} heartbeats`
          this.#saveState()
          if (missCount >= DEFAULT_LIMITS.HEARTBEAT_MISSES_BEFORE_KILL) {
            log.error("killing plugin after heartbeat misses exceeded limit", {
              pluginId: missedPluginId,
              missCount,
              limit: DEFAULT_LIMITS.HEARTBEAT_MISSES_BEFORE_KILL,
            })
            this.kill(missedPluginId)
          }
        }
      })
      this.#heartbeatMonitors.set(pluginId, monitor)

      this.#enforceStartupTimeout(pluginId, entry.startedAt!, resolvedStartupTimeoutMs, (timedOutPluginId) => {
        log.error("startup timeout", { pluginId: timedOutPluginId })
        const e = this.#registry.get(timedOutPluginId)
        if (e && e.state === "starting") {
          this.#registry.pushWarning(
            timedOutPluginId,
            "startup_timeout",
            `Startup timed out after ${resolvedStartupTimeoutMs}ms`,
          )
          e.state = "crashed"
          e.lastError = "Startup timeout"
          this.#forceStop(e)
          this.#saveState()
          void recordEvent({
            pluginId: timedOutPluginId,
            type: "runtime_crashed",
            details: { reason: "startup_timeout" },
          })
        }
      })

      log.info("plugin process spawned", { pluginId, pid: entry.pid })

      // Memory monitor (needs pid from spawned process)
      const memoryMonitor = startMemoryMonitor(
        pluginId,
        entry.pid!,
        DEFAULT_LIMITS.MEMORY_MB,
        10_000,
        (exceededPluginId, currentMb, maxMb) => {
          this.#registry.pushWarning(
            exceededPluginId,
            "memory_limit_exceeded",
            `Memory ${currentMb}MB exceeded limit ${maxMb}MB`,
          )
          log.warn(`Plugin ${exceededPluginId} memory exceeded: ${currentMb}MB / ${maxMb}MB — killing`, {
            pluginId: exceededPluginId,
            currentMb,
            maxMb,
          })
          this.kill(exceededPluginId)
        },
      )
      entry.memoryMonitor = memoryMonitor

      void recordEvent({ pluginId, type: "runtime_started", details: { mode: resolvedMode, pid: entry.pid } })
      return entry
    } catch (err: any) {
      this.#registry.pushWarning(pluginId, "spawn_failed", `Spawn failed: ${err.message}`)
      const pluginErr = new PluginRuntimeError(pluginId, "spawn_failed", `Spawn failed: ${err.message}`, {
        cause: err,
      })
      log.error("failed to spawn plugin process", { pluginId, error: pluginErr.message })
      entry.state = "crashed"
      entry.lastError = pluginErr.toString()
      this.#saveState()
      void recordEvent({
        pluginId,
        type: "runtime_crashed",
        details: { reason: "spawn_failed", error: pluginErr.message },
      })
      return entry
    }
  }

  async stop(pluginId: string, graceful: boolean): Promise<void> {
    const entry = this.#registry.get(pluginId)
    if (!entry) {
      log.warn("stopRuntime called for unknown plugin", { pluginId })
      return
    }

    if (entry.state === "stopped") return

    this.#stopHeartbeatMonitor(pluginId)
    entry.memoryMonitor?.stop()

    if (entry.worker) {
      this.#forceStop(entry)
    } else if (graceful && entry.process) {
      log.info("sending shutdown to plugin", { pluginId })
      const timeout = setTimeout(() => {
        log.warn("graceful shutdown timed out, force killing", { pluginId })
        this.#forceStop(entry)
      }, DEFAULT_LIMITS.SHUTDOWN_GRACE_MS)

      try {
        await entry.process.exited
      } catch {
        // Process already dead
      }
      clearTimeout(timeout)
    } else {
      this.#forceStop(entry)
    }

    entry.state = "stopped"
    entry.process = undefined
    entry.worker = undefined
    entry.pid = undefined
    this.#registry.set(entry)
    this.#saveState()
    log.info("plugin stopped", { pluginId })
  }

  async kill(pluginId: string): Promise<void> {
    const entry = this.#registry.get(pluginId)
    if (!entry) {
      log.warn("killRuntime called for unknown plugin", { pluginId })
      return
    }

    if (entry.state === "stopped") return

    this.#stopHeartbeatMonitor(pluginId)
    entry.memoryMonitor?.stop()
    this.#forceStop(entry)
    entry.state = "stopped"
    entry.process = undefined
    entry.worker = undefined
    entry.pid = undefined
    this.#registry.set(entry)
    this.#saveState()
    void recordEvent({ pluginId, type: "runtime_killed", details: { reason: "explicit_kill" } })
    log.info("plugin killed", { pluginId })
  }

  async reload(pluginId: string, options?: Partial<StartRuntimeOptions>): Promise<RuntimeEntry> {
    const entry = this.#registry.get(pluginId)
    if (!entry) {
      throw new Error(`Cannot reload unknown plugin: ${pluginId}`)
    }

    log.info("reloading plugin", { pluginId })
    await this.stop(pluginId, true)

    return this.start(pluginId, {
      mode: options?.mode ?? entry.mode,
      entryPath: options?.entryPath ?? entry.entryPath ?? "",
      pluginDir: options?.pluginDir ?? entry.pluginDir ?? "",
      source: options?.source ?? (entry.source as StartRuntimeOptions["source"] | undefined),
      scope: options?.scope,
      serverUrl: options?.serverUrl ?? entry.serverUrl,
    })
  }
}

// === Default singleton ===

export const defaultPluginRuntimeSupervisor = new PluginRuntimeSupervisor({
  registry: defaultRuntimeRegistry,
  logs: new PluginLogBuffer(),
})

// === Facade exports for backward compatibility ===

export const getRuntime = (pluginId: string) => defaultPluginRuntimeSupervisor.getRuntime(pluginId)
export const getAllRuntimes = () => defaultPluginRuntimeSupervisor.getAllRuntimes()
export const getRuntimeState = (pluginId: string) => defaultPluginRuntimeSupervisor.getRuntimeState(pluginId)
export const getRuntimeHealth = (pluginId: string) => defaultPluginRuntimeSupervisor.getRuntimeHealth(pluginId)
export const getLogBuffer = () => defaultPluginRuntimeSupervisor.getLogBuffer()
export const restoreRuntimeState = () => defaultPluginRuntimeSupervisor.restoreRuntimeState()
export const startRuntime = (pluginId: string, options: StartRuntimeOptions) =>
  defaultPluginRuntimeSupervisor.start(pluginId, options)
export const stopRuntime = (pluginId: string, graceful: boolean) =>
  defaultPluginRuntimeSupervisor.stop(pluginId, graceful)
export const reloadRuntime = (pluginId: string) => defaultPluginRuntimeSupervisor.reload(pluginId)
export const killRuntime = (pluginId: string) => defaultPluginRuntimeSupervisor.kill(pluginId)
