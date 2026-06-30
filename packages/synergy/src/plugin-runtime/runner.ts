import { parentPort, workerData } from "node:worker_threads"
import { Buffer } from "buffer"
import z from "zod"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import type {
  PluginAuthStore,
  PluginCacheStore,
  PluginConfigAccessor,
  PluginDescriptor,
  PluginHooks,
  PluginInput,
} from "@ericsanchezok/synergy-plugin"
import type { BunShell, BunShellOutput, BunShellPromise, ShellExpression } from "@ericsanchezok/synergy-plugin/shell"
import { MESSAGE_DELIMITER } from "./protocol.js"
import type {
  HostBridgeMethod,
  HostToPlugin,
  IsolatedPluginInputData,
  PluginToHost,
  RuntimeToolContextData,
  SerializedError,
} from "./protocol.js"

type RunnerWorkerData = { entryPath: string; input: IsolatedPluginInputData }

let entryPath = process.argv[2] ?? (workerData as RunnerWorkerData | undefined)?.entryPath
let inputData = (workerData as RunnerWorkerData | undefined)?.input
let hooks: PluginHooks | undefined
let pluginId = inputData?.pluginId ?? ""
const pendingBridge = new Map<
  string,
  { resolve(value: unknown): void; reject(error: Error): void; timeout: ReturnType<typeof setTimeout> }
>()
const activeToolAbort = new Map<string, AbortController>()
let heartbeatTimer: ReturnType<typeof setInterval> | undefined

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause ? serializeError(error.cause) : undefined,
    }
  }
  return { name: "Error", message: String(error) }
}

function deserializeError(error: SerializedError): Error {
  const err = new Error(error.message)
  err.name = error.name
  err.stack = error.stack
  return err
}

function post(message: PluginToHost) {
  if (parentPort) {
    parentPort.postMessage(message)
    return
  }
  if (typeof process.send === "function") {
    process.send(JSON.stringify(message) + MESSAGE_DELIMITER)
  }
}

function postResponse(requestId: string, run: () => Promise<unknown>) {
  run().then(
    (value) => post({ type: "response", requestId, ok: true, value }),
    (error) => post({ type: "response", requestId, ok: false, error: serializeError(error) }),
  )
}

function bridge(method: HostBridgeMethod, params: unknown): Promise<unknown> {
  const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return new Promise((resolve, reject) => {
    const timeoutMs = inputData?.runtimeLimits.bridgeRequestTimeoutMs
    if (!timeoutMs) {
      reject(new Error(`Host bridge request attempted before plugin runtime initialization: ${method}`))
      return
    }
    const timeout = setTimeout(() => {
      pendingBridge.delete(requestId)
      reject(new Error(`Host bridge request timed out: ${method}`))
    }, timeoutMs)
    pendingBridge.set(requestId, { resolve, reject, timeout })
    post({ type: "hostRequest", requestId, method, params })
  })
}

function shellCommand(strings: TemplateStringsArray, expressions: ShellExpression[]): string {
  let command = ""
  for (let i = 0; i < strings.length; i++) {
    command += strings[i]
    const expression = expressions[i]
    if (expression === undefined) continue
    if (Array.isArray(expression)) command += expression.map((item) => String(item)).join(" ")
    else command += String(expression)
  }
  return command
}

function createShell(
  options: { cwd?: string; env?: Record<string, string | undefined>; throws?: boolean } = {},
): BunShell {
  const shell = ((strings: TemplateStringsArray, ...expressions: ShellExpression[]) => {
    const command = shellCommand(strings, expressions)
    const promise = bridge("shell.run", {
      cmd: command,
      cwd: options.cwd,
      env: options.env,
      throws: options.throws,
    }).then((result: any): BunShellOutput => {
      const stdout = Buffer.from(String(result?.stdout ?? ""))
      const stderr = Buffer.from(String(result?.stderr ?? ""))
      const output: BunShellOutput = {
        stdout,
        stderr,
        exitCode: Number(result?.exitCode ?? 0),
        text: () => stdout.toString(),
        json: () => JSON.parse(stdout.toString()),
        arrayBuffer: () => stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.byteLength),
        bytes: () => new Uint8Array(stdout),
        blob: () => new Blob([stdout]),
      }
      return output
    }) as BunShellPromise

    ;(promise as any).stdin = new WritableStream()
    ;(promise as any).cwd = (cwd: string) => {
      options.cwd = cwd
      return promise
    }
    ;(promise as any).env = (env: Record<string, string> | undefined) => {
      options.env = env
      return promise
    }
    ;(promise as any).quiet = () => promise
    ;(promise as any).lines = async function* () {
      const text = await promise.text()
      for (const line of text.split("\n")) yield line
    }
    ;(promise as any).text = async () => (await promise).text()
    ;(promise as any).json = async () => (await promise).json()
    ;(promise as any).arrayBuffer = async () => (await promise).arrayBuffer()
    ;(promise as any).blob = async () => (await promise).blob()
    ;(promise as any).nothrow = () => promise
    ;(promise as any).throws = () => promise
    return promise
  }) as BunShell

  shell.braces = (pattern: string) => [pattern]
  shell.escape = (input: string) => JSON.stringify(input)
  shell.env = (env?: Record<string, string | undefined>) => createShell({ ...options, env })
  shell.cwd = (cwd?: string) => createShell({ ...options, cwd })
  shell.nothrow = () => createShell({ ...options, throws: false })
  shell.throws = (throws: boolean) => createShell({ ...options, throws })
  return shell
}

function createConfigStore(): PluginConfigAccessor {
  return {
    get: async () => (await bridge("config.get", {})) as Record<string, any>,
    set: async (values) => {
      await bridge("config.replace", { values })
    },
  }
}

function createAuthStore(): PluginAuthStore {
  return {
    get: async (key) => (await bridge("secret.get", { key })) as string | undefined,
    set: async (key, value) => {
      await bridge("secret.set", { key, value })
    },
    delete: async (key) => {
      await bridge("secret.delete", { key })
    },
    has: async (key) => (await bridge("secret.get", { key })) !== undefined,
  }
}

function createCacheStore(input: IsolatedPluginInputData): PluginCacheStore {
  return {
    directory: input.cacheDir,
    get: async (key) => (await bridge("cache.get", { key })) as any,
    set: async (key, value, ttl) => {
      await bridge("cache.set", { key, value, ttl })
    },
    delete: async (key) => {
      await bridge("cache.delete", { key })
    },
  }
}

function createInput(input: IsolatedPluginInputData): PluginInput {
  const serverUrl = new URL(input.serverUrl)
  return {
    client: createSynergyClient({ baseUrl: serverUrl.toString() }),
    scope: input.scope as PluginInput["scope"],
    directory: input.directory,
    worktree: input.scope.worktree,
    serverUrl,
    $: createShell({ cwd: input.pluginDir }),
    pluginDir: input.pluginDir,
    config: createConfigStore(),
    auth: createAuthStore(),
    cache: createCacheStore(input),
  }
}

function findDescriptor(mod: Record<string, unknown>, expectedPluginId: string): PluginDescriptor {
  const descriptors = Object.values(mod).filter(
    (value): value is PluginDescriptor =>
      !!value && typeof value === "object" && !Array.isArray(value) && "id" in value && "init" in value,
  )
  const descriptor = descriptors.find((item) => item.id === expectedPluginId)
  if (!descriptor) throw new Error(`No PluginDescriptor with id "${expectedPluginId}" found in ${entryPath}`)
  if (typeof descriptor.init !== "function") throw new Error(`PluginDescriptor "${expectedPluginId}" has no init()`)
  return descriptor
}

async function init(input: IsolatedPluginInputData) {
  if (!entryPath) throw new Error("Missing plugin entryPath")
  pluginId = input.pluginId
  inputData = input
  startHeartbeat(input.runtimeLimits.heartbeatIntervalMs)
  const mod = await import(entryPath)
  const descriptor = findDescriptor(mod, input.pluginId)
  hooks = await descriptor.init(createInput(input))
  const tools = Object.entries(hooks.tool ?? {}).map(([id, def]) => {
    let schema: unknown
    try {
      schema = z.toJSONSchema(z.object(def.args))
    } catch {}
    return {
      id,
      description: def.description,
      display: def.display,
      schema,
    }
  })
  const hookNames = Object.entries(hooks)
    .filter(([name, value]) => name !== "dispose" && name !== "tool" && typeof value === "function")
    .map(([name]) => name)
  post({ type: "ready", tools, hooks: hookNames })
}

async function invokeTool(requestId: string, toolId: string, args: unknown, context?: RuntimeToolContextData) {
  const def = hooks?.tool?.[toolId]
  if (!def) throw new Error(`Unknown plugin tool: ${toolId}`)
  if (!inputData) throw new Error("Plugin runtime is not initialized")
  const abortController = new AbortController()
  activeToolAbort.set(requestId, abortController)
  const contextData = { ...context, toolId, callID: context?.callID ?? requestId, abort: undefined }
  try {
    return def.execute(args as any, {
      sessionID: context?.sessionID ?? "",
      messageID: context?.messageID ?? "",
      agent: context?.agent ?? "",
      abort: abortController.signal,
      directory: context?.directory ?? inputData.directory,
      ask: async (request) => {
        await bridge("permission.request", { ...request, context: contextData })
      },
      task: {
        run: (request) => bridge("task.run", { ...request, context: contextData }) as any,
      },
      tools: {
        invoke: (request) => bridge("tool.invoke", { ...request, context: contextData }) as any,
      },
    })
  } finally {
    activeToolAbort.delete(requestId)
  }
}

async function triggerHook(hook: string, input: unknown, output: unknown) {
  const fn = (hooks as any)?.[hook]
  if (typeof fn !== "function") return output
  const next = await fn(input, output)
  return next === undefined ? output : next
}

async function shutdown() {
  await hooks?.dispose?.()
  process.exit(0)
}

function handle(message: HostToPlugin) {
  switch (message.type) {
    case "init":
      entryPath = entryPath ?? process.argv[2]
      postResponse("init", () => init(message.input))
      break
    case "invokeTool":
      postResponse(message.requestId, () =>
        invokeTool(message.requestId, message.toolId, message.args, message.context),
      )
      break
    case "abortTool": {
      const controller = activeToolAbort.get(message.requestId)
      controller?.abort(new DOMException(message.reason ?? "Plugin tool aborted by host", "AbortError"))
      break
    }
    case "triggerHook":
      postResponse(message.requestId, () => triggerHook(message.hook, message.input, message.output))
      break
    case "bridgeResponse": {
      const pending = pendingBridge.get(message.requestId)
      if (!pending) return
      pendingBridge.delete(message.requestId)
      clearTimeout(pending.timeout)
      if (message.ok) pending.resolve(message.value)
      else pending.reject(deserializeError(message.error))
      break
    }
    case "reload":
      if (inputData) postResponse("reload", () => init(inputData!))
      break
    case "shutdown":
      void shutdown()
      break
    case "ping":
      post({ type: "heartbeat" })
      break
  }
}

function startHeartbeat(intervalMs: number) {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => post({ type: "heartbeat" }), intervalMs)
  heartbeatTimer.unref?.()
}

parentPort?.on("message", (message) => handle(message as HostToPlugin))
process.on("message", (raw) => {
  try {
    const text = typeof raw === "string" ? raw.trim() : String(raw)
    if (!text) return
    handle(JSON.parse(text) as HostToPlugin)
  } catch (error) {
    post({ type: "log", level: "error", message: `Malformed host message: ${String(error)}` })
  }
})

if (inputData) startHeartbeat(inputData.runtimeLimits.heartbeatIntervalMs)

if (inputData) {
  init(inputData).catch((error) => {
    post({ type: "log", level: "error", message: serializeError(error).message })
    throw error
  })
}
