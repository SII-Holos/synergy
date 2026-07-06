import { Log } from "@/util/log"
import fs from "fs"
import path from "path"
import { recordEvent } from "../plugin/audit.js"
import type {
  HostToPlugin,
  IsolatedPluginInputData,
  HostBridgeHandler,
  RuntimeRequestMessage,
  RuntimeToolContextData,
} from "./protocol.js"
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
import * as ManifestReader from "../plugin/manifest-reader"
import { PluginPaths } from "../plugin/paths.js"
import { PluginArtifact } from "@ericsanchezok/synergy-plugin"
import { PluginLogBuffer } from "./logs.js"
import { Global } from "../global/index.js"
import { Config } from "../config/config.js"
import { DEFAULT_SERVER_URL } from "../server/defaults.js"
import { sha256Content, sha256File } from "../util/crypto.js"
import {
  RuntimeRegistry,
  defaultRuntimeRegistry,
  type RuntimeEntry,
  type RuntimeMode,
  type RuntimeState,
  type PersistedRuntimeEntry,
} from "./registry.js"

import { resolveInstalledPluginPolicy, type PluginSource } from "../plugin/trust.js"
import type { Scope } from "../scope/index.js"

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

function normalizeRuntimePath(input: string | undefined): string {
  return input ? path.resolve(input) : ""
}

function sameRuntimeLimits(left: RuntimeLimits, right: RuntimeLimits): boolean {
  return (
    left.startupTimeoutMs === right.startupTimeoutMs &&
    left.toolInvocationTimeoutMs === right.toolInvocationTimeoutMs &&
    left.hookInvocationTimeoutMs === right.hookInvocationTimeoutMs &&
    left.bridgeRequestTimeoutMs === right.bridgeRequestTimeoutMs &&
    left.taskRunTimeoutMs === right.taskRunTimeoutMs &&
    left.shutdownGraceMs === right.shutdownGraceMs &&
    left.maxConcurrentRequests === right.maxConcurrentRequests &&
    left.maxLogBytesPerMinute === right.maxLogBytesPerMinute &&
    left.memoryMb === right.memoryMb &&
    left.memoryPollIntervalMs === right.memoryPollIntervalMs &&
    left.heartbeatIntervalMs === right.heartbeatIntervalMs &&
    left.heartbeatMissesBeforeKill === right.heartbeatMissesBeforeKill
  )
}

function runtimeMatchesRequest(
  entry: RuntimeEntry,
  request: {
    mode: RuntimeMode
    entryPath: string
    pluginDir: string
    source: PluginSource
    serverUrl: string
    limits: RuntimeLimits
    launchSignature?: string
  },
): boolean {
  return (
    entry.mode === request.mode &&
    normalizeRuntimePath(entry.entryPath) === normalizeRuntimePath(request.entryPath) &&
    normalizeRuntimePath(entry.pluginDir) === normalizeRuntimePath(request.pluginDir) &&
    entry.source === request.source &&
    (entry.serverUrl ?? DEFAULT_SERVER_URL) === request.serverUrl &&
    sameRuntimeLimits(entry.limits, request.limits) &&
    entry.launchSignature === request.launchSignature
  )
}

function runtimeHasLiveClient(entry: RuntimeEntry): boolean {
  if (entry.mode === "in-process") return true
  if (!entry.request || !entry.send) return false
  if (entry.mode === "worker") return Boolean(entry.worker)
  if (entry.mode === "process") return Boolean(entry.process)
  return false
}
function runtimeRequestLabel(message: RuntimeRequestMessage): Record<string, unknown> {
  return message.type === "triggerHook"
    ? { requestType: message.type, hook: message.hook }
    : { requestType: message.type, toolId: message.toolId }
}

function runtimeValueMetrics(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  return {
    ...(Array.isArray(record.system) ? { systemCount: record.system.length } : {}),
    ...(Array.isArray(record.messages) ? { messageCount: record.messages.length } : {}),
  }
}

function fileHashOrMissing(filepath: string | undefined): string {
  if (!filepath) return "missing:"
  try {
    return fs.existsSync(filepath) && fs.statSync(filepath).isFile()
      ? sha256File(filepath)
      : `missing:${path.resolve(filepath)}`
  } catch {
    return `missing:${path.resolve(filepath)}`
  }
}

function runtimeLaunchSignature(input: { pluginDir: string; entryPath: string | undefined }): string {
  const manifestPath = path.join(input.pluginDir, PluginArtifact.manifestFile)
  const integrityPath = path.join(input.pluginDir, PluginArtifact.integrityFile)
  return sha256Content(
    JSON.stringify({
      manifest: fileHashOrMissing(manifestPath),
      entry: fileHashOrMissing(input.entryPath),
      integrity: fileHashOrMissing(integrityPath),
    }),
  )
}

function persistedRuntimeEntryUsable(entry: PersistedRuntimeEntry): boolean {
  if (!entry.pluginDir || !entry.entryPath) return false
  if (!fs.existsSync(path.join(entry.pluginDir, PluginArtifact.manifestFile))) return false
  if (!fs.existsSync(entry.entryPath)) return false
  return true
}

function fallbackRuntimeScope(): IsolatedPluginInputData["scope"] {
  return {
    id: "home",
    type: "home",
    directory: Global.Path.home,
    worktree: Global.Path.home,
    sandboxes: [],
    time: { created: 0, updated: 0 },
  }
}

function runtimeScope(options: StartRuntimeOptions): IsolatedPluginInputData["scope"] {
  const scope = options.scope
  if (!scope) return fallbackRuntimeScope()
  if (scope.type === "project") return scope
  return {
    ...scope,
    sandboxes: [],
    time: { created: 0, updated: 0 },
  }
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
  source: PluginSource
  entryPath: string
  pluginDir: string
  scope?: Scope
  serverUrl?: string
}

// === PluginRuntimeSupervisor ===

export class PluginRuntimeSupervisor {
  #registry: RuntimeRegistry
  #logBuffer: PluginLogBuffer
  #persist: RuntimeStatePersistence
  #heartbeatMonitors = new Map<string, { stop: () => void }>()
  #runtimeRequestAborts = new Map<string, AbortController>()

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

  #runtimeRequestKey(pluginId: string, requestKey: string): string {
    return `${pluginId}:${requestKey}`
  }

  #registerRuntimeRequestAbort(
    pluginId: string,
    message: RuntimeRequestMessage,
    controller: AbortController,
  ): string[] {
    const requestKeys = new Set<string>([message.requestId])
    if (message.type === "invokeTool" && message.context?.callID) requestKeys.add(message.context.callID)
    const keys = [...requestKeys].map((key) => this.#runtimeRequestKey(pluginId, key))
    for (const key of keys) this.#runtimeRequestAborts.set(key, controller)
    return keys
  }

  #clearRuntimeRequestAbort(keys: string[]): void {
    for (const key of keys) this.#runtimeRequestAborts.delete(key)
  }

  #abortRuntimeRequest(pluginId: string, requestId: string, reason: string): void {
    this.#runtimeRequestAborts.get(this.#runtimeRequestKey(pluginId, requestId))?.abort(new Error(reason))
  }

  #bridgeSignal(pluginId: string, params: unknown): AbortSignal | undefined {
    if (!params || typeof params !== "object") return undefined
    const context = (params as { context?: { callID?: unknown } }).context
    const callID = typeof context?.callID === "string" ? context.callID : undefined
    if (!callID) return undefined
    return this.#runtimeRequestAborts.get(this.#runtimeRequestKey(pluginId, callID))?.signal
  }

  #attachRuntimeClient(
    pluginId: string,
    entry: RuntimeEntry,
    runtime: { onMessage(handler: (msg: any) => void): void; send(msg: HostToPlugin): void },
  ): void {
    const pending = new Map<
      string,
      {
        resolve(value: unknown): void
        reject(error: Error): void
        timeout: ReturnType<typeof setTimeout>
        abortKeys: string[]
      }
    >()
    const cleanupRuntimeWaiter = (
      requestId: string,
      waiter: { timeout: ReturnType<typeof setTimeout>; abortKeys: string[] },
    ) => {
      pending.delete(requestId)
      clearTimeout(waiter.timeout)
      this.#clearRuntimeRequestAbort(waiter.abortKeys)
    }
    runtime.onMessage((msg) => {
      if (msg.type === "ready") {
        const tools = msg.tools ?? []
        const hooks = msg.hooks ?? []
        entry.tools = tools
        entry.hooks = hooks
        log.info("plugin runtime ready capabilities", {
          pluginId,
          mode: entry.mode,
          toolCount: tools.length,
          hooks,
        })
        this.#saveState()
        return
      }
      if (msg.type !== "response") return
      const waiter = pending.get(msg.requestId)
      if (!waiter) return
      cleanupRuntimeWaiter(msg.requestId, waiter)
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
        const startedAt = Date.now()
        const label = runtimeRequestLabel(message)
        log.debug("plugin runtime request dispatch", { pluginId, mode: entry.mode, ...label })
        const controller = new AbortController()
        const abortKeys = this.#registerRuntimeRequestAbort(pluginId, message, controller)
        const timeoutMs =
          message.type === "triggerHook" ? entry.limits.hookInvocationTimeoutMs : entry.limits.toolInvocationTimeoutMs
        const cleanup = () => {
          const waiter = pending.get(message.requestId)
          if (waiter) cleanupRuntimeWaiter(message.requestId, waiter)
          else this.#clearRuntimeRequestAbort(abortKeys)
        }
        const timeout = setTimeout(() => {
          const reason = `Plugin runtime ${message.type === "triggerHook" ? "hook" : "tool"} timed out after ${timeoutMs}ms for "${pluginId}"`
          log.warn("plugin runtime request timed out", { pluginId, mode: entry.mode, ...label, timeoutMs })
          cleanup()
          controller.abort(new Error(reason))
          if (message.type === "invokeTool") runtime.send({ type: "abortTool", requestId: message.requestId, reason })
          reject(new Error(reason))
        }, timeoutMs)
        pending.set(message.requestId, {
          resolve(value) {
            log.debug("plugin runtime request completed", {
              pluginId,
              mode: entry.mode,
              ...label,
              durationMs: Date.now() - startedAt,
              output: runtimeValueMetrics(value),
            })
            resolve(value)
          },
          reject(error) {
            log.warn("plugin runtime request failed", {
              pluginId,
              mode: entry.mode,
              ...label,
              durationMs: Date.now() - startedAt,
              error: error.message,
            })
            reject(error)
          },
          timeout,
          abortKeys,
        })
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
      return executeBridgeMethod({ pluginId, pluginDir, method, params, signal: this.#bridgeSignal(pluginId, params) })
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
    const loadedState = await this.#persist.load()
    const savedState = loadedState.filter((entry) => {
      const usable = persistedRuntimeEntryUsable(entry)
      if (!usable) {
        log.warn("skipping invalid restored plugin runtime state", {
          pluginId: entry.pluginId,
          pluginDir: entry.pluginDir,
          entryPath: entry.entryPath,
        })
      }
      return usable
    })
    this.#registry.restore(savedState)
    this.#saveState()
    if (savedState.length > 0) {
      log.info("restored runtime state", { count: savedState.length })
    }
  }

  // === Lifecycle methods ===

  async start(pluginId: string, options: StartRuntimeOptions): Promise<RuntimeEntry> {
    const existing = this.#registry.get(pluginId)
    // Read manifest for runtime preferences (mode, resources)
    const manifest = await ManifestReader.read(options.pluginDir)
    const config = await Config.current().catch(() => undefined)
    const source = options.source
    const policy = await resolveInstalledPluginPolicy({
      pluginId,
      pluginDir: options.pluginDir,
      manifest,
      source,
      devMode: false,
      policy: config?.pluginRuntimePolicy,
    })

    // Resolve runtime mode: caller wins, otherwise the shared plugin policy decides.
    let runtimeDecision: string
    let resolvedMode: RuntimeMode
    if (options.mode) {
      resolvedMode = options.mode
      runtimeDecision = `caller-override:${resolvedMode}`
    } else {
      resolvedMode = policy.runtimeMode
      runtimeDecision = `policy:${resolvedMode}`
    }

    const launchMode = resolveRuntimeLaunchMode(resolvedMode, runtimeDecision)
    resolvedMode = launchMode.mode
    runtimeDecision = launchMode.runtimeDecision

    const manifestResources = manifest.runtime?.resources
    const limits = resolveRuntimeLimits(config?.pluginRuntimePolicy?.limits, manifestResources)
    const serverUrl = options.serverUrl ?? DEFAULT_SERVER_URL
    const launchSignature = runtimeLaunchSignature({
      pluginDir: options.pluginDir,
      entryPath: options.entryPath,
    })

    if (existing && existing.state !== "stopped" && existing.state !== "crashed") {
      if (
        runtimeHasLiveClient(existing) &&
        runtimeMatchesRequest(existing, {
          mode: resolvedMode,
          entryPath: options.entryPath,
          pluginDir: options.pluginDir,
          source: options.source,
          serverUrl,
          limits,
          launchSignature,
        })
      ) {
        log.warn("plugin already running", { pluginId, state: existing.state })
        return existing
      }
      log.info("plugin runtime launch spec changed; restarting", {
        pluginId,
        state: existing.state,
        previousMode: existing.mode,
        nextMode: resolvedMode,
        previousEntryPath: existing.entryPath,
        nextEntryPath: options.entryPath,
        previousLaunchSignature: existing.launchSignature,
        nextLaunchSignature: launchSignature,
      })
      await this.stop(pluginId, true)
    }

    const latestExisting = this.#registry.get(pluginId)
    const restarts =
      latestExisting && (latestExisting.state === "crashed" || latestExisting.state === "stopped")
        ? latestExisting.restarts + 1
        : latestExisting
          ? latestExisting.restarts
          : 0

    const entry: RuntimeEntry = {
      pluginId,
      mode: resolvedMode,
      runtimeDecision,
      entryPath: options.entryPath,
      pluginDir: options.pluginDir,
      source: options.source,
      serverUrl,
      state: "starting",
      restarts,
      startedAt: Date.now(),
      limits,
      launchSignature,
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
      const scope = runtimeScope(options)
      const serverUrl = entry.serverUrl ?? DEFAULT_SERVER_URL

      const input: IsolatedPluginInputData = {
        pluginId,
        pluginDir: options.pluginDir,
        cacheDir: PluginPaths.cacheDir(pluginId),
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
      const scope = runtimeScope(options)
      const serverUrl = entry.serverUrl ?? DEFAULT_SERVER_URL

      const input: IsolatedPluginInputData = {
        pluginId,
        pluginDir: options.pluginDir,
        cacheDir: PluginPaths.cacheDir(pluginId),
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
    const source = options?.source ?? entry.source
    if (!source) {
      throw new Error(`Cannot reload plugin runtime without a source: ${pluginId}`)
    }

    return this.start(pluginId, {
      mode: options?.mode ?? entry.mode,
      entryPath: options?.entryPath ?? entry.entryPath ?? "",
      pluginDir: options?.pluginDir ?? entry.pluginDir ?? "",
      source,
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
      this.#abortRuntimeRequest(pluginId, requestId, "Host tool call aborted")
      entry.send?.({ type: "abortTool", requestId, reason: "Host tool call aborted" })
    }
    abort?.addEventListener("abort", cancel, { once: true })
    try {
      return await entry.request({
        type: "invokeTool",
        requestId,
        toolId,
        args,
        context: context ? { ...context, toolId: context.toolId ?? toolId } : undefined,
      })
    } finally {
      abort?.removeEventListener("abort", cancel)
    }
  }

  async triggerHook(pluginId: string, hook: string, input: unknown, output: unknown): Promise<unknown> {
    const entry = this.#registry.get(pluginId)
    if (!entry?.request) {
      log.debug("plugin runtime hook skipped: runtime is not running", { pluginId, hook, state: entry?.state })
      return output
    }
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
