import type { PluginDefinition, PluginManifestType, PluginInvocationContext } from "@ericsanchezok/synergy-plugin"
import { PLUGIN_RUNTIME_PROTOCOL_VERSION } from "./protocol.js"
import type { PluginHostServiceMethod, RuntimeInvocationContextData } from "./protocol.js"
import { spawnPluginProcess } from "./process-host.js"
import { PluginRuntimeRegistry, pluginRuntimeKey, type PluginRuntimeEntry } from "./registry.js"
import { DEFAULT_LIMITS, type RuntimeLimits } from "./health.js"
import { PluginLogBuffer } from "./logs.js"
import { createPluginInvocationContext } from "./context-factory.js"
import { pathToFileURL } from "node:url"
import { Installation } from "../global/installation.js"

export type PluginRuntimeErrorCode =
  | "PLUGIN_UNAVAILABLE"
  | "TIMEOUT"
  | "CANCELLED"
  | "RUNTIME_ERROR"
  | "STALE_GENERATION"

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
  method: PluginHostServiceMethod
  params: unknown
  signal: AbortSignal
}

export type PluginHostServiceDispatcher = (input: PluginHostServiceInvocationInput) => Promise<unknown>

interface RuntimeInvocationRecord {
  context: RuntimeInvocationContextData
  controller: AbortController
  entry: PluginRuntimeEntry
  pluginDir: string
  manifest: PluginManifestType
}

export class PluginRuntimeManager {
  readonly registry = new PluginRuntimeRegistry()
  readonly logs = new PluginLogBuffer()
  #invocations = new Map<string, RuntimeInvocationRecord>()

  constructor(private readonly hostServices: PluginHostServiceDispatcher = async () => undefined) {}

  async start(input: StartPluginRuntimeInput): Promise<PluginRuntimeEntry> {
    const manifest = input.manifest
    const generation = manifest.artifacts.generation
    const key = pluginRuntimeKey(manifest.id, manifest.version, generation)
    const existing = this.registry.get(key)
    if (existing?.state === "ready") return existing
    const expectedHandlers = manifest.contributions
      .filter((item) =>
        ["operation", "tool", "hook", "authProvider", "lifecycle.upgrade", "lifecycle.uninstall"].includes(item.kind),
      )
      .map((item) => `${item.kind}:${item.id}`)
      .sort()
    const limits = input.limits ?? DEFAULT_LIMITS
    const mode = input.mode ?? "process"
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
    }
    this.registry.set(entry)

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
        throw error
      }
    }

    let readyResolve: (() => void) | undefined
    let readyReject: ((error: Error) => void) | undefined
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })
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
      onReady(message) {
        if (message.protocolVersion !== PLUGIN_RUNTIME_PROTOCOL_VERSION) {
          readyReject?.(new Error(`Plugin runtime protocol mismatch: ${message.protocolVersion}`))
          return
        }
        if (message.generation !== generation) {
          readyReject?.(new Error(`Plugin runtime generation mismatch: ${message.generation}`))
          return
        }
        const actual = [...message.handlerIds].sort()
        if (JSON.stringify(actual) !== JSON.stringify(expectedHandlers)) {
          readyReject?.(
            new Error(
              `Plugin runtime handlers do not match manifest: expected [${expectedHandlers}], received [${actual}]`,
            ),
          )
          return
        }
        entry.handlerIds = actual
        entry.state = "ready"
        entry.lastHeartbeatAt = Date.now()
        readyResolve?.()
      },
      onHostRequest: async (request) => {
        const invocation = this.#invocations.get(request.invocationId)
        if (!invocation) throw new Error(`Unknown plugin invocation: ${request.invocationId}`)
        return this.hostServices({
          pluginId: entry.pluginId,
          pluginDir: invocation.pluginDir,
          manifest: invocation.manifest,
          invocation: invocation.context,
          method: request.method,
          params: request.params,
          signal: invocation.controller.signal,
        })
      },
      onHeartbeat() {
        entry.lastHeartbeatAt = Date.now()
      },
      onLog: (log) => this.logs.append(entry.pluginId, log),
      onExit: (exitCode, signal) => {
        if (entry.state === "stopped") return
        entry.state = "crashed"
        entry.lastError = `Plugin runtime exited (${exitCode ?? signal ?? "unknown"})`
        readyReject?.(new Error(entry.lastError))
      },
    })

    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Plugin runtime startup timed out after ${limits.startupTimeoutMs}ms`)),
            limits.startupTimeoutMs,
          ),
        ),
      ])
    } catch (error) {
      entry.state = "crashed"
      entry.lastError = error instanceof Error ? error.message : String(error)
      await entry.process.stop(limits.shutdownGraceMs).catch(() => undefined)
      throw error
    }

    if (input.activate !== false) await this.activate(key, limits.shutdownGraceMs)
    return entry
  }

  async activate(key: string, graceMs = DEFAULT_LIMITS.shutdownGraceMs) {
    const previous = this.registry.activate(key)
    if (!previous) return
    previous.state = "draining"
    if (previous.inFlight === 0) void this.#stopEntry(previous, graceMs)
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
    input.signal?.addEventListener("abort", abort, { once: true })
    const timeoutMs = input.timeoutMs ?? DEFAULT_LIMITS.toolInvocationTimeoutMs
    const timeout = setTimeout(
      () => controller.abort(new DOMException("Plugin invocation timed out", "TimeoutError")),
      timeoutMs,
    )
    const cancelRuntime = () => {
      entry.process?.send({ type: "abort", requestId, reason: String(controller.signal.reason ?? "cancelled") })
    }
    controller.signal.addEventListener("abort", cancelRuntime, { once: true })
    entry.inFlight++
    this.#invocations.set(requestId, {
      context: input.context,
      controller,
      entry,
      pluginDir: input.pluginDir,
      manifest: input.manifest,
    })
    try {
      const invocation =
        entry.mode === "process"
          ? entry.process!.request({
              type: "invoke",
              requestId,
              generation: entry.generation,
              handlerId: input.handlerId,
              input: input.value,
              context: input.context,
            })
          : this.#invokeInProcess(
              entry,
              requestId,
              input.handlerId,
              input.value,
              input.context,
              input.pluginDir,
              input.manifest,
              controller,
            ).then((value) => ({ requestId, generation: entry.generation, ok: true as const, value }))
      const response = await Promise.race([
        invocation,
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => {
              const timeout =
                controller.signal.reason instanceof DOMException && controller.signal.reason.name === "TimeoutError"
              reject(
                new PluginRuntimeError(
                  timeout ? "TIMEOUT" : "CANCELLED",
                  timeout ? `Plugin invocation timed out after ${timeoutMs}ms` : "Plugin invocation cancelled",
                ),
              )
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
      return response.value
    } catch (error) {
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
        void this.#stopEntry(entry, DEFAULT_LIMITS.shutdownGraceMs)
      }
    }
  }

  async stop(pluginId: string, graceMs = DEFAULT_LIMITS.shutdownGraceMs) {
    const entry = this.registry.active(pluginId)
    if (entry) await this.#stopEntry(entry, graceMs)
  }

  async stopGeneration(key: string, graceMs = DEFAULT_LIMITS.shutdownGraceMs) {
    const entry = this.registry.get(key)
    if (entry) await this.#stopEntry(entry, graceMs)
  }

  async #stopEntry(entry: PluginRuntimeEntry, graceMs: number) {
    if (entry.state === "stopped") return
    entry.state = "stopped"
    await entry.process?.stop(graceMs)
    await entry.definition?.deactivate?.()
    this.registry.delete(entry.key)
  }

  #logger(pluginId: string) {
    const append = (level: string, message: string) =>
      this.logs.append(pluginId, { timestamp: Date.now(), level, message })
    return {
      debug: (message: string) => {
        append("debug", message)
      },
      info: (message: string) => {
        append("info", message)
      },
      warn: (message: string) => {
        append("warn", message)
      },
      error: (message: string) => {
        append("error", message)
      },
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
      capabilities: new Set(manifest.capabilities.map((item) => item.id)),
      log: this.#logger(entry.pluginId),
      invokeHost: (method, params) =>
        this.hostServices({
          pluginId: entry.pluginId,
          pluginDir,
          manifest,
          invocation: data,
          method,
          params,
          signal: controller.signal,
        }),
    })
    if (contribution.kind === "lifecycle.uninstall") return contribution.handler(context)
    return (contribution.handler as (input: unknown, context: PluginInvocationContext) => Promise<unknown>)(
      value,
      context,
    )
  }
}

export const defaultPluginRuntimeManager = new PluginRuntimeManager()
