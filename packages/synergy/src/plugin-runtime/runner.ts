import type {
  PluginDefinition,
  PluginInvocationContext,
  PluginLogger,
  PluginContribution,
} from "@ericsanchezok/synergy-plugin"
import {
  deserializePluginRuntimeError,
  PLUGIN_RUNTIME_PROTOCOL_VERSION,
  serializePluginRuntimeError,
  type HostToPlugin,
  type PluginHostServiceMethod,
  type PluginToHost,
  type RuntimeActivationData,
  type RuntimeInvocationContextData,
} from "./protocol.js"
import { createPluginInvocationContext } from "./context-factory.js"

const entryPath = process.argv[2]
let definition: PluginDefinition | undefined
let activation: RuntimeActivationData | undefined
let heartbeat: ReturnType<typeof setInterval> | undefined
const aborts = new Map<string, AbortController>()
const hostRequests = new Map<
  string,
  { resolve(value: unknown): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> }
>()

function post(message: PluginToHost) {
  process.send?.(message)
}

function findDefinition(module: Record<string, unknown>, pluginId: string): PluginDefinition {
  const candidate = [module.default, ...Object.values(module)].find((value): value is PluginDefinition => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    return record.id === pluginId && Array.isArray(record.contributions) && Array.isArray(record.handlerIds)
  })
  if (!candidate) throw new Error(`Runtime entry does not export definePlugin() definition for "${pluginId}"`)
  return candidate
}

async function activate(input: RuntimeActivationData) {
  if (activation) throw new Error(`Plugin runtime generation ${activation.generation} is already active`)
  if (!entryPath) throw new Error("Plugin runtime entry path is missing")
  const module = (await import(entryPath)) as Record<string, unknown>
  definition = findDefinition(module, input.pluginId)
  if (definition.version !== input.version) {
    throw new Error(`Plugin runtime version mismatch: expected ${input.version}, received ${definition.version}`)
  }
  activation = input
  await definition.activate?.({
    pluginId: input.pluginId,
    version: input.version,
    generation: input.generation,
    log: logger(),
  })
  heartbeat = setInterval(() => post({ type: "heartbeat" }), input.runtimeLimits.heartbeatIntervalMs)
  heartbeat.unref?.()
  post({
    type: "ready",
    protocolVersion: PLUGIN_RUNTIME_PROTOCOL_VERSION,
    generation: input.generation,
    handlerIds: [...definition.handlerIds].sort(),
  })
}

function logger(): PluginLogger {
  return {
    debug: (message, details) => post({ type: "log", level: "debug", message, details }),
    info: (message, details) => post({ type: "log", level: "info", message, details }),
    warn: (message, details) => post({ type: "log", level: "warn", message, details }),
    error: (message, details) => post({ type: "log", level: "error", message, details }),
  }
}

function hostRequest(invocationId: string, method: PluginHostServiceMethod, params: unknown): Promise<unknown> {
  const requestId = crypto.randomUUID()
  const timeoutMs = activation?.runtimeLimits.hostServiceRequestTimeoutMs
  if (!timeoutMs) return Promise.reject(new Error("Plugin runtime is not active"))
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      hostRequests.delete(requestId)
      reject(new Error(`Host service timed out: ${method}`))
    }, timeoutMs)
    hostRequests.set(requestId, { resolve, reject, timeout })
    post({ type: "hostRequest", requestId, invocationId, method, params })
  })
}

function contextFor(
  requestId: string,
  data: RuntimeInvocationContextData,
  abort: AbortSignal,
  contribution: PluginContribution,
): PluginInvocationContext {
  return createPluginInvocationContext({
    requestId,
    data,
    runtime: {
      hostVersion: activation?.hostVersion ?? "unknown",
      pluginVersion: activation?.version ?? "unknown",
      pluginGeneration: activation?.generation ?? "unknown",
      protocolVersion: activation?.protocolVersion ?? PLUGIN_RUNTIME_PROTOCOL_VERSION,
    },
    signal: abort,
    capabilities: new Set(
      (activation?.capabilities ?? []).filter(
        (capability) => capability !== "agent.call" || contribution.requires?.includes(capability),
      ),
    ),
    log: logger(),
    invokeHost: (method, params) => hostRequest(requestId, method, params),
  })
}

function handler(handlerId: string): PluginContribution & { handler: (...args: never[]) => unknown } {
  const contribution = definition?.contributions.find((item) => `${item.kind}:${item.id}` === handlerId)
  if (!contribution || !("handler" in contribution) || typeof contribution.handler !== "function") {
    throw new Error(`Unknown plugin runtime handler: ${handlerId}`)
  }
  return contribution as PluginContribution & { handler: (...args: never[]) => unknown }
}

async function invoke(message: Extract<HostToPlugin, { type: "invoke" }>) {
  if (!activation || !definition) throw new Error("Plugin runtime is not active")
  if (message.generation !== activation.generation) {
    throw new Error(`Stale plugin generation: ${message.generation}`)
  }
  const controller = new AbortController()
  aborts.set(message.requestId, controller)
  try {
    const contribution = handler(message.handlerId)
    if (contribution.kind === "lifecycle.uninstall") {
      return await contribution.handler(contextFor(message.requestId, message.context, controller.signal, contribution))
    }
    return await contribution.handler(
      message.input as never,
      contextFor(message.requestId, message.context, controller.signal, contribution) as never,
    )
  } finally {
    aborts.delete(message.requestId)
  }
}

async function shutdown() {
  if (heartbeat) clearInterval(heartbeat)
  await definition?.deactivate?.()
  process.exit(0)
}

function handle(message: HostToPlugin) {
  if (message.type === "activate") {
    void activate(message.input).catch((error) => {
      post({ type: "log", level: "error", message: serializePluginRuntimeError(error).message })
      process.exit(1)
    })
    return
  }
  if (message.type === "invoke") {
    void invoke(message).then(
      (value) =>
        post({ type: "response", requestId: message.requestId, generation: message.generation, ok: true, value }),
      (error) => {
        const serialized = serializePluginRuntimeError(error)
        post({ type: "log", level: "error", message: serialized.message })
        post({
          type: "response",
          requestId: message.requestId,
          generation: message.generation,
          ok: false,
          error: serialized,
        })
      },
    )
    return
  }
  if (message.type === "abort") {
    aborts.get(message.requestId)?.abort(new DOMException(message.reason ?? "Plugin invocation aborted", "AbortError"))
    return
  }
  if (message.type === "hostResponse") {
    const pending = hostRequests.get(message.requestId)
    if (!pending) return
    hostRequests.delete(message.requestId)
    clearTimeout(pending.timeout)
    if (message.ok) pending.resolve(message.value)
    else pending.reject(deserializePluginRuntimeError(message.error))
    return
  }
  if (message.type === "shutdown") {
    void shutdown()
    return
  }
  if (message.type === "ping") post({ type: "heartbeat" })
}

process.on("message", (message) => {
  const parsed = typeof message === "string" ? JSON.parse(message) : message
  handle(parsed as HostToPlugin)
})
