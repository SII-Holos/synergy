import { AsyncLocalStorage } from "node:async_hooks"
import type { PluginDefinition, PluginManifestType, PluginInvocationContext } from "@ericsanchezok/synergy-plugin"
import { PLUGIN_RUNTIME_PROTOCOL_VERSION } from "./protocol.js"
import type { PluginHostServiceMethod, RuntimeInvocationContextData } from "./protocol.js"
import { spawnPluginProcess } from "./process-host.js"
import { PluginRuntimeRegistry, pluginRuntimeKey, type PluginRuntimeEntry } from "./registry.js"
import type { RuntimeLimits } from "./health.js"
import { PluginLogBuffer } from "./logs.js"
import { contributionGatedCapabilities, createPluginInvocationContext } from "./context-factory.js"
import { pathToFileURL } from "node:url"
import { Installation } from "@ericsanchezok/synergy-harness/global/installation"
import { startMemoryMonitor, type MemoryMonitorInput, type MemoryMonitor } from "./resource-limits.js"
import { pluginAgentCallRuntime } from "./agent-call-runtime.js"
import { resolvePluginRuntimeLimits } from "./runtime-limits.js"

export type PluginRuntimeErrorCode =
  "PLUGIN_UNAVAILABLE" | "TIMEOUT" | "CANCELLED" | "RUNTIME_ERROR" | "STALE_GENERATION"

export class PluginRuntimeError extends Error {
  constructor(
    readonly code: PluginRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "PluginRuntimeError"
  }
}

export interface StartPluginRuntimeInput {
  manifest: PluginManifestType
  pluginDir: string
  entryPath: string
  limits?: RuntimeLimits
  activate?: boolean
  mode?: "process" | "inProcess"
  trustedBuiltin?: boolean
}

export interface PluginHostServiceInvocationInput {
  pluginId: string
  pluginDir: string
  manifest: PluginManifestType
  invocation: RuntimeInvocationContextData
  handlerId?: string
  method: PluginHostServiceMethod
  params: unknown
  signal: AbortSignal
  limits?: RuntimeLimits
  assertAuthority?: () => void
}

export type PluginHostServiceDispatcher = (input: PluginHostServiceInvocationInput) => Promise<unknown>
export interface PluginRuntimeManagerDependencies {
  startMemoryMonitor(input: MemoryMonitorInput): MemoryMonitor
  bootstrapTimeoutMs?: number
  monotonicNow?(): number
  withInvocation?(
    context: RuntimeInvocationContextData,
    signal: AbortSignal,
    fn: (context: RuntimeInvocationContextData) => Promise<unknown>,
    capabilities: ReadonlySet<string>,
  ): Promise<unknown>
}

interface RuntimeInvocationRecord {
  context: RuntimeInvocationContextData
  controller: AbortController
  entry: PluginRuntimeEntry
  pluginDir: string
  manifest: PluginManifestType
  handlerId: string
  run: ReturnType<typeof AsyncLocalStorage.snapshot>
  pending: Set<Promise<unknown>>
}

export class PluginRuntimeManager {
  readonly registry = new PluginRuntimeRegistry()
  readonly logs = new PluginLogBuffer()
  #invocations = new Map<string, RuntimeInvocationRecord>()
  #startInputs = new Map<string, StartPluginRuntimeInput>()
  #starting = new Map<
    string,
    {
      pluginId: string
      mode: PluginRuntimeEntry["mode"]
      controller: AbortController
      promise: Promise<PluginRuntimeEntry>
    }
  >()
  #stopping = new WeakMap<PluginRuntimeEntry, Promise<void>>()
  #lastRecovery:
    | {
        action: "recycle"
        reason: "memory_limit"
        at: number
        beforeBytes: number
        afterBytes: number
        reclaimedBytes: number
      }
    | undefined

  constructor(
    private readonly hostServices: PluginHostServiceDispatcher = async () => undefined,
    private readonly dependencies: PluginRuntimeManagerDependencies = { startMemoryMonitor },
  ) {}

  resourceStats() {
    const entries = this.registry
      .list()
      .filter((entry) => entry.mode === "process" && entry.process?.process.exitCode === null)
    const measured = entries.filter((entry) => entry.memory?.currentRssBytes !== undefined)
    return {
      processCount: entries.length,
      measuredProcessCount: measured.length,
      currentBytes: measured.reduce((sum, entry) => sum + (entry.memory?.currentRssBytes ?? 0), 0),
      baselineBytes: measured.reduce((sum, entry) => sum + (entry.memory?.baselineRssBytes ?? 0), 0),
      peakBytes: measured.reduce((sum, entry) => sum + (entry.memory?.peakRssBytes ?? 0), 0),
      retainedBytes: measured.reduce(
        (sum, entry) =>
          sum +
          Math.max(
            0,
            (entry.memory?.currentRssBytes ?? 0) -
              (entry.memory?.baselineRssBytes ?? entry.memory?.currentRssBytes ?? 0),
          ),
        0,
      ),
      heapUsedBytes: measured.reduce((sum, entry) => sum + (entry.memory?.heapUsedBytes ?? 0), 0),
      externalBytes: measured.reduce((sum, entry) => sum + (entry.memory?.externalBytes ?? 0), 0),
      arrayBuffersBytes: measured.reduce((sum, entry) => sum + (entry.memory?.arrayBuffersBytes ?? 0), 0),
      lastRecovery: this.#lastRecovery,
    }
  }

  async start(input: StartPluginRuntimeInput): Promise<PluginRuntimeEntry> {
    const manifest = input.manifest
    const key = pluginRuntimeKey(manifest.id, manifest.version, manifest.artifacts.generation)
    const pending = this.#starting.get(key)
    const existing = this.registry.get(key)
    if (pending?.controller.signal.aborted || (existing?.mode === "process" && this.#stopping.has(existing))) {
      throw new PluginRuntimeError("PLUGIN_UNAVAILABLE", `Plugin runtime is unavailable: ${manifest.id}`)
    }
    if (existing?.state === "ready" && (existing.mode === "inProcess" || !pending)) return existing
    if (pending) return pending.promise

    const controller = new AbortController()
    const mode = input.mode ?? "process"
    const starting = { pluginId: manifest.id, mode, controller, promise: this.#start(input, controller.signal) }
    this.#starting.set(key, starting)
    try {
      return await starting.promise
    } finally {
      if (this.#starting.get(key) === starting) this.#starting.delete(key)
    }
  }

  async #start(input: StartPluginRuntimeInput, signal: AbortSignal): Promise<PluginRuntimeEntry> {
    const manifest = input.manifest
    const generation = manifest.artifacts.generation
    const key = pluginRuntimeKey(manifest.id, manifest.version, generation)
    const existing = this.registry.get(key)
    if (existing?.state === "ready") return existing
    const expectedHandlers = manifest.contributions
      .filter((item) =>
        [
          "operation",
          "tool",
          "hook",
          "cli.command",
          "authProvider",
          "lifecycle.install",
          "lifecycle.upgrade",
          "lifecycle.uninstall",
        ].includes(item.kind),
      )
      .map((item) => `${item.kind}:${item.id}`)
      .sort()
    const limits = input.limits ?? (await resolvePluginRuntimeLimits())
    const mode = input.mode ?? "process"
    if (mode === "process") signal.throwIfAborted()
    if (mode === "inProcess" && !input.trustedBuiltin) {
      throw new Error("inProcess runtime is reserved for trusted built-in plugins")
    }
    const entry: PluginRuntimeEntry = {
      key,
      pluginId: manifest.id,
      version: manifest.version,
      generation,
      mode,
      state: "starting",
      handlerIds: [],
      inFlight: 0,
      startedAt: Date.now(),
      limits,
    }
    this.registry.set(entry)
    this.#startInputs.set(key, { ...input, limits })

    if (mode === "inProcess") {
      try {
        const module = (await import(pathToFileURL(input.entryPath).href)) as Record<string, unknown>
        const definition = [module.default, ...Object.values(module)].find((value): value is PluginDefinition => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return false
          const candidate = value as Record<string, unknown>
          return (
            candidate.id === manifest.id &&
            Array.isArray(candidate.contributions) &&
            Array.isArray(candidate.handlerIds)
          )
        })
        if (!definition) throw new Error(`Runtime entry does not export definePlugin() definition for "${manifest.id}"`)
        if (definition.version !== manifest.version) {
          throw new Error(
            `Plugin runtime version mismatch: expected ${manifest.version}, received ${definition.version}`,
          )
        }
        const actual = [...definition.handlerIds].sort()
        if (JSON.stringify(actual) !== JSON.stringify(expectedHandlers)) {
          throw new Error(
            `Plugin runtime handlers do not match manifest: expected [${expectedHandlers}], received [${actual}]`,
          )
        }
        entry.definition = definition
        entry.handlerIds = actual
        await definition.activate?.({
          pluginId: manifest.id,
          version: manifest.version,
          generation,
          log: this.#logger(manifest.id),
        })
        entry.state = "ready"
        if (input.activate !== false) await this.activate(key, limits.shutdownGraceMs)
        return entry
      } catch (error) {
        entry.state = "crashed"
        entry.lastError = error instanceof Error ? error.message : String(error)
        this.registry.delete(key)
        this.#startInputs.delete(key)
        throw error
      }
    }

    let readyResolve: (() => void) | undefined
    let readyReject: ((error: Error) => void) | undefined
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
    void ready.catch(() => undefined)
    const now = this.dependencies.monotonicNow ?? (() => performance.now())
    const bootstrapTimeoutMs = this.dependencies.bootstrapTimeoutMs ?? 300_000
    let phase: "bootstrap" | "activation" | undefined
    let deadline = Infinity
    let timeout: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const timeoutError = () =>
      new Error(
        `Plugin runtime ${phase === "bootstrap" ? "bootstrap" : "startup"} timed out after ${phase === "bootstrap" ? bootstrapTimeoutMs : limits.startupTimeoutMs}ms`,
      )
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (entry.state !== "stopped") entry.state = "crashed"
      entry.lastError = error.message
      readyReject?.(error)
    }
    const cancelled = () =>
      fail(signal.reason instanceof Error ? signal.reason : new Error("Plugin runtime stopped during startup"))
    const checkDeadline = () => {
      if (settled) return false
      if (signal.aborted) {
        cancelled()
        return false
      }
      if (this.registry.get(key) !== entry || entry.state !== "starting") {
        fail(new Error("Plugin runtime ownership changed during startup"))
        return false
      }
      if (now() >= deadline) {
        fail(timeoutError())
        return false
      }
      return true
    }
    signal.addEventListener("abort", cancelled, { once: true })
    try {
      entry.process = spawnPluginProcess({
        entryPath: input.entryPath,
        pluginDir: input.pluginDir,
        activation: {
          pluginId: manifest.id,
          version: manifest.version,
          generation,
          hostVersion: Installation.VERSION,
          protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
          capabilities: manifest.capabilities.map((item) => item.id),
          runtimeLimits: limits,
        },
        onStart(nextPhase) {
          if (!checkDeadline()) return false
          phase = nextPhase
          const duration = phase === "bootstrap" ? bootstrapTimeoutMs : limits.startupTimeoutMs
          deadline = now() + duration
          clearTimeout(timeout)
          timeout = setTimeout(() => fail(timeoutError()), duration)
          return true
        },
        onError: (error) => {
          if (!settled) fail(error)
          else if (entry.state === "ready")
            void this.#stopEntry(entry, limits.shutdownGraceMs, error).catch(() => undefined)
        },
        onReady(message) {
          if (!checkDeadline()) return
          if (phase !== "activation") {
            fail(new Error("Plugin runtime ready before activation"))
            return
          }
          if (message.protocolVersion !== PLUGIN_RUNTIME_PROTOCOL_VERSION) {
            fail(new Error(`Plugin runtime protocol mismatch: ${message.protocolVersion}`))
            return
          }
          if (message.generation !== generation) {
            fail(new Error(`Plugin runtime generation mismatch: ${message.generation}`))
            return
          }
          if (!Array.isArray(message.handlerIds) || message.handlerIds.some((id) => typeof id !== "string")) {
            fail(new Error("Plugin runtime handlers do not match manifest"))
            return
          }
          const actual = [...message.handlerIds].sort()
          if (JSON.stringify(actual) !== JSON.stringify(expectedHandlers)) {
            fail(
              new Error(
                `Plugin runtime handlers do not match manifest: expected [${expectedHandlers}], received [${actual}]`,
              ),
            )
            return
          }
          settled = true
          clearTimeout(timeout)
          entry.handlerIds = actual
          entry.state = "ready"
          entry.lastHeartbeatAt = Date.now()
          readyResolve?.()
        },
        onHostRequest: async (request) => {
          const invocation = this.#invocations.get(request.invocationId)
          if (!invocation || invocation.entry !== entry)
            throw new Error(`Unknown plugin invocation: ${request.invocationId}`)
          return this.#hostRequest(invocation, {
            pluginId: entry.pluginId,
            pluginDir: invocation.pluginDir,
            manifest: invocation.manifest,
            invocation: invocation.context,
            handlerId: invocation.handlerId,
            method: request.method,
            params: request.params,
            signal: invocation.controller.signal,
          })
        },
        onHeartbeat(message) {
          if (entry.state !== "ready") return
          entry.lastHeartbeatAt = Date.now()
          entry.memory = {
            ...entry.memory,
            heapUsedBytes: message.memory.heapUsedBytes,
            heapTotalBytes: message.memory.heapTotalBytes,
            externalBytes: message.memory.externalBytes,
            arrayBuffersBytes: message.memory.arrayBuffersBytes,
          }
        },
        onLog: (log) => this.logs.append(entry.pluginId, log),
        onExit: (exitCode, signal) => {
          entry.memoryMonitor?.stop()
          entry.memoryMonitor = undefined
          if (entry.state === "stopped" || entry.state === "crashed") return
          const error = new Error(`Plugin runtime exited (${exitCode ?? signal ?? "unknown"})`)
          if (!settled) fail(error)
          else {
            entry.state = "crashed"
            entry.lastError = error.message
          }
        },
      })
      const pid = entry.process.process.pid
      entry.memoryMonitor = this.dependencies.startMemoryMonitor({
        pluginId: entry.pluginId,
        pid,
        maxMb: limits.maxMemoryMb,
        intervalMs: limits.memorySampleIntervalMs,
        onSample: (currentMb) => {
          if (this.registry.get(entry.key) !== entry || entry.process?.process.pid !== pid) return
          const currentRssBytes = currentMb * 1024 * 1024
          entry.memory = {
            ...entry.memory,
            currentRssBytes,
            baselineRssBytes:
              entry.memory?.baselineRssBytes === undefined
                ? currentRssBytes
                : Math.min(entry.memory.baselineRssBytes, currentRssBytes),
            peakRssBytes: Math.max(entry.memory?.peakRssBytes ?? 0, currentRssBytes),
            sampledAt: Date.now(),
          }
        },
        onExceed: (currentMb) => {
          if (
            this.registry.get(entry.key) !== entry ||
            this.registry.active(entry.pluginId) !== entry ||
            entry.process?.process.pid !== pid ||
            entry.state !== "ready" ||
            entry.memoryRecyclePending
          )
            return
          entry.memoryRecyclePending = true
          void this.#recycleForMemory(entry, currentMb * 1024 * 1024, limits.shutdownGraceMs)
        },
      })

      await ready
      signal.throwIfAborted()
      if (this.registry.get(key) !== entry || entry.state !== "ready")
        throw new Error("Plugin runtime stopped during startup")
      if (input.activate !== false) await this.activate(key, limits.shutdownGraceMs)
      signal.throwIfAborted()
      return entry
    } catch (error) {
      await this.#stopEntry(
        entry,
        limits.shutdownGraceMs,
        error instanceof Error ? error : new Error(String(error)),
      ).catch(() => undefined)
      throw error
    } finally {
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener("abort", cancelled)
    }
  }

  async activate(key: string, graceMs?: number) {
    const previous = this.registry.activate(key)
    if (!previous) return
    previous.state = "draining"
    await pluginAgentCallRuntime().cancelGeneration(
      previous.pluginId,
      previous.generation,
      "Plugin generation replaced",
    )
    if (previous.inFlight === 0) void this.#stopEntry(previous, graceMs ?? previous.limits.shutdownGraceMs)
  }

  async invoke(input: {
    pluginId: string
    handlerId: string
    value: unknown
    context: RuntimeInvocationContextData
    pluginDir: string
    manifest: PluginManifestType
    timeoutMs?: number
    signal?: AbortSignal
    runtimeKey?: string
  }): Promise<unknown> {
    const entry = input.runtimeKey ? this.registry.get(input.runtimeKey) : this.registry.active(input.pluginId)
    if (!entry || entry.state !== "ready" || (entry.mode === "process" ? !entry.process : !entry.definition)) {
      throw new PluginRuntimeError("PLUGIN_UNAVAILABLE", `Plugin runtime is unavailable: ${input.pluginId}`)
    }
    if (!entry.handlerIds.includes(input.handlerId)) {
      throw new PluginRuntimeError("RUNTIME_ERROR", `Unknown plugin handler: ${input.handlerId}`)
    }
    const requestId = crypto.randomUUID()
    const controller = new AbortController()
    const abort = () => controller.abort(input.signal?.reason)
    if (input.signal?.aborted) abort()
    else input.signal?.addEventListener("abort", abort, { once: true })
    const timeoutMs = input.timeoutMs ?? (await resolvePluginRuntimeLimits()).contributionInvokeTimeoutMs
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException("Plugin invocation timed out", "TimeoutError"))
    }, timeoutMs)
    const abortError = () => {
      return new PluginRuntimeError(
        timedOut ? "TIMEOUT" : "CANCELLED",
        timedOut ? `Plugin invocation timed out after ${timeoutMs}ms` : "Plugin invocation cancelled",
      )
    }
    const cancelRuntime = () => {
      const error = abortError()
      entry.process?.send({ type: "abort", requestId, reason: String(controller.signal.reason ?? "cancelled") })
      // Single-settle the IPC pending so a late child response cannot resolve after cancel/timeout.
      entry.process?.rejectRequest(requestId, error)
    }
    controller.signal.addEventListener("abort", cancelRuntime, { once: true })
    entry.inFlight++
    const execute = async (context: RuntimeInvocationContextData) => {
      const record: RuntimeInvocationRecord = {
        context,
        controller,
        entry,
        pluginDir: input.pluginDir,
        manifest: input.manifest,
        handlerId: input.handlerId,
        run: AsyncLocalStorage.snapshot(),
        pending: new Set(),
      }
      this.#invocations.set(requestId, record)
      let returned = false
      try {
        const invocation =
          entry.mode === "process"
            ? entry.process!.request({
                type: "invoke",
                requestId,
                generation: entry.generation,
                handlerId: input.handlerId,
                input: input.value,
                context,
              })
            : this.#invokeInProcess(
                entry,
                requestId,
                input.handlerId,
                input.value,
                context,
                input.pluginDir,
                input.manifest,
                controller,
              ).then((value) => ({ requestId, generation: entry.generation, ok: true as const, value }))
        // Reject only after process pending is tracked so pre-aborted signals still settle the request.
        if (controller.signal.aborted) cancelRuntime()
        // Process mode settles cancel/timeout through rejectRequest on the same pending promise.
        // In-process still races an abort rejection because there is no IPC pending map.
        const response =
          entry.mode === "process"
            ? await invocation
            : await Promise.race([
                invocation,
                new Promise<never>((_, reject) => {
                  if (controller.signal.aborted) {
                    reject(abortError())
                    return
                  }
                  controller.signal.addEventListener(
                    "abort",
                    () => {
                      reject(abortError())
                    },
                    { once: true },
                  )
                }),
              ])
        if (
          response.generation !== entry.generation ||
          (!input.runtimeKey && this.registry.active(input.pluginId)?.key !== entry.key)
        ) {
          throw new PluginRuntimeError("STALE_GENERATION", `Plugin generation changed during invocation`)
        }
        returned = true
        return response.value
      } finally {
        this.#invocations.delete(requestId)
        controller.signal.removeEventListener("abort", cancelRuntime)
        const unfinished = record.pending.size
        controller.abort(new DOMException("Plugin invocation ended", "AbortError"))
        await Promise.allSettled([...record.pending])
        if (returned && unfinished) throw new Error("Plugin returned before its Host Services settled")
      }
    }
    try {
      return await (this.dependencies.withInvocation
        ? this.dependencies.withInvocation(
            input.context,
            controller.signal,
            execute,
            new Set(input.manifest.capabilities.map((item) => item.id)),
          )
        : execute(input.context))
    } catch (error) {
      if (timedOut || input.signal?.aborted) {
        if (timedOut && entry.mode === "process") await this.#stopEntry(entry, 0)
        throw abortError()
      }
      if (error instanceof PluginRuntimeError) {
        if (error.code === "TIMEOUT" && entry.mode === "process") await this.#stopEntry(entry, 0)
        throw error
      }
      const wrapped = new PluginRuntimeError("RUNTIME_ERROR", error instanceof Error ? error.message : String(error), {
        cause: error,
      })
      if (error && typeof error === "object" && "code" in error) {
        Object.assign(wrapped, { domainCode: String(error.code) })
      }
      throw wrapped
    } finally {
      clearTimeout(timeout)
      controller.signal.removeEventListener("abort", cancelRuntime)
      input.signal?.removeEventListener("abort", abort)
      this.#invocations.delete(requestId)
      entry.inFlight--
      if (this.registry.get(entry.key)?.state === "draining" && entry.inFlight === 0) {
        void this.#stopEntry(entry, entry.limits.shutdownGraceMs)
      }
    }
  }

  async stop(pluginId: string, graceMs?: number) {
    const starting = [...this.#starting.values()].filter(
      (item) => item.pluginId === pluginId && item.mode === "process",
    )
    const entries = this.registry
      .list()
      .filter(
        (entry) =>
          entry.pluginId === pluginId &&
          (this.registry.active(pluginId) === entry || (entry.mode === "process" && this.#starting.has(entry.key))),
      )
    for (const item of starting) item.controller.abort(new Error("Plugin runtime stopped during startup"))
    await Promise.all(entries.map((entry) => this.#stopEntry(entry, graceMs ?? entry.limits.shutdownGraceMs)))
    await Promise.allSettled(starting.map((item) => item.promise))
  }

  async stopGeneration(key: string, graceMs?: number) {
    const starting = this.#starting.get(key)
    if (starting?.mode === "process") starting.controller.abort(new Error("Plugin runtime stopped during startup"))
    const entry = this.registry.get(key)
    if (entry) await this.#stopEntry(entry, graceMs ?? entry.limits.shutdownGraceMs)
    if (starting?.mode === "process") await starting.promise.catch(() => undefined)
  }

  async #stopEntry(entry: PluginRuntimeEntry, graceMs: number, failure?: Error) {
    const existing = this.#stopping.get(entry)
    if (existing) return existing
    if (entry.state !== "stopped") entry.state = failure ? "crashed" : "stopped"
    if (failure) entry.lastError = failure.message
    if (entry.mode === "process" && this.registry.get(entry.key) === entry)
      this.#starting.get(entry.key)?.controller.abort(new Error("Plugin runtime stopped during startup"))
    const stopping = Promise.resolve().then(async () => {
      try {
        try {
          entry.memoryMonitor?.stop()
        } finally {
          entry.memoryMonitor = undefined
        }
        await pluginAgentCallRuntime().cancelGeneration(entry.pluginId, entry.generation)
      } finally {
        try {
          await entry.process?.stop(graceMs)
          await entry.definition?.deactivate?.()
        } finally {
          if (this.registry.get(entry.key) === entry) {
            this.registry.delete(entry.key)
            this.#startInputs.delete(entry.key)
          }
        }
      }
    })
    this.#stopping.set(entry, stopping)
    return stopping
  }

  async #recycleForMemory(entry: PluginRuntimeEntry, beforeBytes: number, graceMs: number) {
    if (this.registry.get(entry.key) !== entry || this.registry.active(entry.pluginId) !== entry) return
    const restartInput = this.#startInputs.get(entry.key)
    await this.#stopEntry(entry, graceMs)
    this.#lastRecovery = {
      action: "recycle",
      reason: "memory_limit",
      at: Date.now(),
      beforeBytes,
      afterBytes: 0,
      reclaimedBytes: beforeBytes,
    }
    if (!restartInput || this.registry.list().some((candidate) => candidate.pluginId === entry.pluginId)) return
    await this.start(restartInput).catch((error) => {
      this.logs.append(entry.pluginId, {
        timestamp: Date.now(),
        level: "error",
        message: `Plugin runtime memory recycle failed: ${error instanceof Error ? error.message : String(error)}`,
      })
    })
  }

  #logger(pluginId: string) {
    const append = (level: string, message: string, details?: Record<string, unknown>) =>
      this.logs.append(pluginId, { timestamp: Date.now(), level, message, details })
    return {
      debug: (message: string, details?: Record<string, unknown>) => {
        append("debug", message, details)
      },
      info: (message: string, details?: Record<string, unknown>) => {
        append("info", message, details)
      },
      warn: (message: string, details?: Record<string, unknown>) => {
        append("warn", message, details)
      },
      error: (message: string, details?: Record<string, unknown>) => {
        append("error", message, details)
      },
    }
  }

  async #hostRequest(record: RuntimeInvocationRecord, input: PluginHostServiceInvocationInput) {
    record.controller.signal.throwIfAborted()
    const assertAuthority = () => {
      record.controller.signal.throwIfAborted()
      if (record.entry.state !== "ready" || this.registry.active(record.entry.pluginId) !== record.entry)
        throw new PluginRuntimeError("STALE_GENERATION", "Plugin connection authority changed during invocation")
    }
    if (input.method.startsWith("host.connection.")) {
      assertAuthority()
      input.assertAuthority = assertAuthority
    }
    const pending = record.run(() => this.hostServices(input))
    record.pending.add(pending)
    try {
      return await pending
    } finally {
      record.pending.delete(pending)
    }
  }

  async #invokeInProcess(
    entry: PluginRuntimeEntry,
    requestId: string,
    handlerId: string,
    value: unknown,
    data: RuntimeInvocationContextData,
    pluginDir: string,
    manifest: PluginManifestType,
    controller: AbortController,
  ) {
    const contribution = entry.definition?.contributions.find((item) => `${item.kind}:${item.id}` === handlerId)
    if (!contribution || !("handler" in contribution) || typeof contribution.handler !== "function") {
      throw new Error(`Unknown plugin runtime handler: ${handlerId}`)
    }
    const context = createPluginInvocationContext({
      requestId,
      data,
      runtime: {
        hostVersion: Installation.VERSION,
        pluginVersion: entry.version,
        pluginGeneration: entry.generation,
        protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
      },
      signal: controller.signal,
      capabilities: contributionGatedCapabilities(
        manifest.capabilities.map((item) => item.id),
        contribution,
      ),
      log: this.#logger(entry.pluginId),
      invokeHost: (method, params) => {
        const record = this.#invocations.get(requestId)
        if (!record || record.entry !== entry) return Promise.reject(new Error("Plugin invocation is closed"))
        return this.#hostRequest(record, {
          pluginId: entry.pluginId,
          pluginDir,
          manifest,
          invocation: data,
          handlerId,
          method,
          params,
          signal: controller.signal,
        })
      },
    })
    if (contribution.kind === "lifecycle.install" || contribution.kind === "lifecycle.uninstall") {
      return contribution.handler(context)
    }
    return (contribution.handler as (input: unknown, context: PluginInvocationContext) => Promise<unknown>)(
      value,
      context,
    )
  }
}
