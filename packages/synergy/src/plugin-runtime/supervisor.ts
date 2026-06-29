import { Log } from "@/util/log"
import { recordEvent } from "../plugin/audit.js"
import type { HostToPlugin, IsolatedPluginInputData, HostBridgeHandler, RuntimeToolContextData } from "./protocol.js"
import { resolveRuntimeMode } from "./mode-resolver.js"
import { spawnPluginProcess } from "./process-host.js"
import { canSpawnPluginWorker, spawnPluginWorker } from "./worker-host.js"
import type { Worker } from "node:worker_threads"
import { PluginRuntimeError } from "./errors.js"
import { resolveRuntimeLimits } from "./health.js"
import type { RuntimeLimits } from "./health.js"
import type { RuntimeHealth } from "./health.js"
import { ConcurrencyLimiter, startMemoryMonitor, LogRateLimiter } from "./resource-limits.js"
import { writeRuntimeState, readRuntimeState } from "./state-persist.js"
import { createBridgeEnforcementHandler } from "./bridge-enforcement.js"
import { executeBridgeMethod } from "./bridge-handlers.js"
import { getApproval } from "../plugin/consent/approval-store.js"
import type { PluginManifest as PluginManifestType } from "@ericsanchezok/synergy-plugin"
import * as ManifestReader from "../plugin/manifest-reader"
import { baseCapabilities } from "../plugin/capability.js"
import { computeRisk } from "../plugin/consent/risk.js"
import { PluginLogBuffer } from "./logs.js"
import { Global } from "../global/index.js"
import { Config } from "../config/config.js"
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

export function resolveRuntimeLaunchMode(
  mode: RuntimeMode,
  runtimeDecision: string,
  workerAvailable = canSpawnPluginWorker(),
): { mode: RuntimeMode; runtimeDecision: string } {
  if (mode === "worker" && !workerAvailable) {
    return {
      mode: "process",
      runtimeDecision: `${runtimeDecision}->process:packaged-runner`,
    }
  }
  return { mode, runtimeDecision }
}

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
    limits: RuntimeLimits,
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

      if (now - lastHeartbeatAt > limits.heartbeatIntervalMs) {
        missCount++
        if (missCount >= limits.heartbeatMissesBeforeKill) {
          clearInterval(interval)
          onMissedHeartbeat(pluginId, missCount)
        }
      } else {
        missCount = 0
      }
    }, limits.heartbeatIntervalMs)

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

  #attachRuntimeClient(
    pluginId: string,
    entry: RuntimeEntry,
    runtime: { onMessage(handler: (msg: any) => void): void; send(msg: HostToPlugin): void },
  ): void {
    const pending = new Map<
      string,
      { resolve(value: unknown): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> }
    >()
    runtime.onMessage((msg) => {
      if (msg.type === "ready") {
        entry.tools = msg.tools ?? []
        entry.hooks = msg.hooks ?? []
        this.#saveState()
        return
      }
      if (msg.type !== "response") return
      const waiter = pending.get(msg.requestId)
      if (!waiter) return
      pending.delete(msg.requestId)
      clearTimeout(waiter.timeout)
      if (msg.ok) {
        waiter.resolve(msg.value)
      } else {
        const error = new Error(msg.error?.message ?? "Plugin runtime request failed")
        error.name = msg.error?.name ?? "PluginRuntimeRequestError"
        error.stack = msg.error?.stack
        waiter.reject(error)
      }
    })
    entry.send = runtime.send
    entry.request = (message) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(message.requestId)
          reject(new Error(`Plugin runtime request timed out for "${pluginId}"`))
        }, entry.limits.requestTimeoutMs)
        pending.set(message.requestId, { resolve, reject, timeout })
        runtime.send(message as HostToPlugin)
      })
  }

  async #createBridgeHandler(pluginId: string, pluginDir: string): Promise<HostBridgeHandler> {
    return async (_requestId, method, params) => {
      const approval = await getApproval(pluginId)
      const enforcer = createBridgeEnforcementHandler(pluginId, approval?.approvedCapabilities ?? [])
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
    const config = await Config.current().catch(() => undefined)
    const source = options.source ?? "npm"
    const risk = manifest ? computeRisk(baseCapabilities(manifest), manifest) : "low"
    const userTrusted = source === "builtin" || source === "official" || source === "local"

    // Resolve runtime mode: caller wins, then resolveRuntimeMode, then default
    let runtimeDecision: string
    let resolvedMode: RuntimeMode
    if (options.mode) {
      resolvedMode = options.mode
      runtimeDecision = `caller-override:${resolvedMode}`
    } else {
      resolvedMode = resolveRuntimeMode({
        source,
        manifestMode: manifest?.runtime?.mode,
        devMode: false,
        userTrusted,
        risk,
        policy: config?.pluginRuntimePolicy,
      })
      runtimeDecision = `policy:${resolvedMode}`
    }

    const launchMode = resolveRuntimeLaunchMode(resolvedMode, runtimeDecision)
    resolvedMode = launchMode.mode
    runtimeDecision = launchMode.runtimeDecision

    const manifestResources = manifest?.runtime?.resources
    const limits = resolveRuntimeLimits(config?.pluginRuntimePolicy?.limits, manifestResources)

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
      limits,
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
      return this.#startWorker(pluginId, entry, options, resolvedMode)
    }

    // process mode
    return this.#startProcess(pluginId, entry, options, resolvedMode)
  }

  async #startWorker(
    pluginId: string,
    entry: RuntimeEntry,
    options: StartRuntimeOptions,
    resolvedMode: RuntimeMode,
  ): Promise<RuntimeEntry> {
    try {
      const scope =
        options.scope ??
        ({
          id: "home",
          type: "home" as const,
          directory: Global.Path.home,
          worktree: Global.Path.home,
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
        runtimeLimits: entry.limits,
      }
      const enforcementHandler = await this.#createBridgeHandler(pluginId, options.pluginDir)
      const concurrency = new ConcurrencyLimiter(entry.limits.maxConcurrentRequests)
      entry.concurrencyLimiter = concurrency
      const logLimiter = new LogRateLimiter(entry.limits.maxLogBytesPerMinute)
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
      this.#attachRuntimeClient(pluginId, entry, spawned)

      this.#enforceStartupTimeout(pluginId, entry.startedAt!, entry.limits.startupTimeoutMs, (timedOutPluginId) => {
        log.error("startup timeout", { pluginId: timedOutPluginId })
        const e = this.#registry.get(timedOutPluginId)
        if (e && e.state === "starting") {
          this.#registry.pushWarning(
            timedOutPluginId,
            "startup_timeout",
            `Startup timed out after ${entry.limits.startupTimeoutMs}ms`,
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
  ): Promise<RuntimeEntry> {
    try {
      const scope =
        options.scope ??
        ({
          id: "home",
          type: "home" as const,
          directory: Global.Path.home,
          worktree: Global.Path.home,
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
        runtimeLimits: entry.limits,
      }

      const enforcementHandler = await this.#createBridgeHandler(pluginId, options.pluginDir)

      // Create resource limiters BEFORE spawn so callbacks can reference them
      const concurrency = new ConcurrencyLimiter(entry.limits.maxConcurrentRequests)
      entry.concurrencyLimiter = concurrency
      const logLimiter = new LogRateLimiter(entry.limits.maxLogBytesPerMinute)
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
      this.#attachRuntimeClient(pluginId, entry, spawned)

      // Start heartbeat monitor
      this.#stopHeartbeatMonitor(pluginId)
      const monitor = this.#startHeartbeatMonitor(pluginId, entry.limits, (missedPluginId, missCount) => {
        log.warn("heartbeat missed, marking unhealthy", { pluginId: missedPluginId, missCount })
        const e = this.#registry.get(missedPluginId)
        if (e) {
          this.#registry.pushWarning(missedPluginId, "heartbeat_missed", `Missed ${missCount} heartbeat(s)`)
          e.state = "unhealthy"
          e.lastError = `Missed ${missCount} heartbeats`
          this.#saveState()
          if (missCount >= entry.limits.heartbeatMissesBeforeKill) {
            log.error("killing plugin after heartbeat misses exceeded limit", {
              pluginId: missedPluginId,
              missCount,
              limit: entry.limits.heartbeatMissesBeforeKill,
            })
            this.kill(missedPluginId)
          }
        }
      })
      this.#heartbeatMonitors.set(pluginId, monitor)

      this.#enforceStartupTimeout(pluginId, entry.startedAt!, entry.limits.startupTimeoutMs, (timedOutPluginId) => {
        log.error("startup timeout", { pluginId: timedOutPluginId })
        const e = this.#registry.get(timedOutPluginId)
        if (e && e.state === "starting") {
          this.#registry.pushWarning(
            timedOutPluginId,
            "startup_timeout",
            `Startup timed out after ${entry.limits.startupTimeoutMs}ms`,
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
        entry.limits.memoryMb,
        entry.limits.memoryPollIntervalMs,
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
    if (graceful) {
      try {
        entry.send?.({ type: "shutdown" })
      } catch {}
    }

    if (entry.worker) {
      this.#forceStop(entry)
    } else if (graceful && entry.process) {
      log.info("sending shutdown to plugin", { pluginId })
      const timeout = setTimeout(() => {
        log.warn("graceful shutdown timed out, force killing", { pluginId })
        this.#forceStop(entry)
      }, entry.limits.shutdownGraceMs)

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

  async invokeTool(
    pluginId: string,
    toolId: string,
    args: unknown,
    context?: RuntimeToolContextData,
    abort?: AbortSignal,
  ): Promise<unknown> {
    const entry = this.#registry.get(pluginId)
    if (!entry?.request) throw new Error(`Plugin runtime is not running: ${pluginId}`)
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    const cancel = () => {
      entry.send?.({ type: "abortTool", requestId, reason: "Host tool call aborted" })
    }
    abort?.addEventListener("abort", cancel, { once: true })
    try {
      return await entry.request({
        type: "invokeTool",
        requestId,
        toolId,
        args,
        context,
      })
    } finally {
      abort?.removeEventListener("abort", cancel)
    }
  }

  async triggerHook(pluginId: string, hook: string, input: unknown, output: unknown): Promise<unknown> {
    const entry = this.#registry.get(pluginId)
    if (!entry?.request) return output
    return entry.request({
      type: "triggerHook",
      requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      hook,
      input,
      output,
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
export const invokeRuntimeTool = (
  pluginId: string,
  toolId: string,
  args: unknown,
  context?: RuntimeToolContextData,
  abort?: AbortSignal,
) => defaultPluginRuntimeSupervisor.invokeTool(pluginId, toolId, args, context, abort)
export const triggerRuntimeHook = (pluginId: string, hook: string, input: unknown, output: unknown) =>
  defaultPluginRuntimeSupervisor.triggerHook(pluginId, hook, input, output)
