import { Config } from "../config/config"
import { ScopeContext } from "../scope/context"
import { Log } from "../util/log"
import { pluginRuntimeManager } from "./runtime"
import { PluginHookPointRegistry } from "./hook-points"
import {
  ensureRuntime,
  getLoadedPlugins,
  getPlugin,
  markContributionDegraded,
  resetAllPluginState,
  state,
  contributions,
  type LoadedPlugin,
} from "./loader"
import { startForPlugin, stopForPlugin } from "./mcp"
import Ajv2020 from "ajv/dist/2020"
import { LightLoopRuntime } from "../session/light-loop-runtime"
import { BlueprintLoopRuntime } from "../blueprint/loop-runtime"

const log = Log.create({ service: "plugin.lifecycle" })

function mcpDeclarations(plugin: LoadedPlugin) {
  return Object.fromEntries(contributions(plugin, "mcp").map((item) => [item.id, item.server]))
}

function hookContributions(plugin: LoadedPlugin, point: string) {
  return contributions(plugin, "hook")
    .filter((item) => item.point === point)
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id))
}

export class PluginHookDeniedError extends Error {
  constructor(
    readonly point: string,
    message: string,
  ) {
    super(message)
    this.name = "PluginHookDeniedError"
  }
}

export function sortPluginHookHandlers<
  Handler extends { plugin: { id: string }; contribution: { id: string; priority: number } },
>(handlers: Handler[]) {
  return [...handlers].sort(
    (left, right) =>
      left.contribution.priority - right.contribution.priority ||
      left.plugin.id.localeCompare(right.plugin.id) ||
      left.contribution.id.localeCompare(right.contribution.id),
  )
}

export function applyPluginHookResult<Output>(
  point: { name: string; mode: "observer" | "transform" | "guard" },
  value: Output,
  result: unknown,
): Output {
  if (point.mode === "observer" || result === undefined) return value
  if (point.mode === "guard") {
    if (
      !result ||
      typeof result !== "object" ||
      !("allow" in result) ||
      typeof (result as { allow?: unknown }).allow !== "boolean"
    ) {
      throw new Error(`Guard hook ${point.name} must return { allow, reason? }`)
    }
    const guard = result as { allow: boolean; reason?: string; value?: Output }
    if (!guard.allow)
      throw new PluginHookDeniedError(point.name, guard.reason ?? `Plugin hook ${point.name} denied the operation`)
    return guard.value === undefined ? value : guard.value
  }
  return result as Output
}

function validateHookValue(schema: Record<string, unknown>, value: unknown, label: string) {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  const validate = ajv.compile(schema)
  if (!validate(value)) throw new Error(`${label}: ${ajv.errorsText(validate.errors)}`)
}

function sessionId(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, unknown>
  if (typeof record.sessionID === "string") return record.sessionID
  if (typeof record.sessionId === "string") return record.sessionId
  if (!record.loop || typeof record.loop !== "object") return undefined
  const loop = record.loop as Record<string, unknown>
  return typeof loop.sessionID === "string"
    ? loop.sessionID
    : typeof loop.sessionId === "string"
      ? loop.sessionId
      : undefined
}

type PluginHookExecution<Output> = {
  value: Output
  matchedHandlers: number
  succeededHandlers: number
  errors: string[]
}

async function executePluginHooks<Input, Output>(
  pointName: string,
  input: Input,
  initial: Output,
  plugins: LoadedPlugin[],
): Promise<PluginHookExecution<Output>> {
  const point = PluginHookPointRegistry.get(pointName)
  validateHookValue(point.inputSchema, input, `Invalid input for hook point ${pointName}`)
  let value = initial
  let succeededHandlers = 0
  const errors: string[] = []
  const handlers = sortPluginHookHandlers(
    plugins.flatMap((plugin) => hookContributions(plugin, pointName).map((contribution) => ({ plugin, contribution }))),
  )
  for (const { plugin, contribution } of handlers) {
    try {
      await ensureRuntime(plugin)
      const result = await pluginRuntimeManager.invoke({
        pluginId: plugin.id,
        handlerId: `hook:${contribution.id}`,
        value: point.mode === "transform" ? value : input,
        context: {
          scopeId: ScopeContext.current.scope.id,
          sessionId: sessionId(input),
          directory: ScopeContext.current.directory,
          actor: { type: "lifecycle" },
        },
        pluginDir: plugin.pluginDir,
        manifest: plugin.manifest,
        timeoutMs: point.timeoutMs,
      })
      value = applyPluginHookResult(point, value, result)
      if (point.mode !== "observer")
        validateHookValue(point.outputSchema, value, `Invalid output for hook point ${pointName}`)
      succeededHandlers++
    } catch (error) {
      if (error instanceof PluginHookDeniedError) throw error
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`Hook ${pointName} handler ${contribution.id} failed: ${message}`)
      markContributionDegraded(plugin, contribution.id, error)
      log.error("plugin contribution failed", {
        pluginId: plugin.id,
        contributionId: contribution.id,
        point: pointName,
        error: message,
      })
      if (point.failure === "fail") throw error
    }
  }
  return { value, matchedHandlers: handlers.length, succeededHandlers, errors }
}

async function triggerPlugins<Input, Output>(
  pointName: string,
  input: Input,
  initial: Output,
  plugins: LoadedPlugin[],
): Promise<Output> {
  return executePluginHooks(pointName, input, initial, plugins).then((result) => result.value)
}

export async function trigger<Input, Output>(pointName: string, input: Input, initial: Output): Promise<Output> {
  const plugins = [...(await getLoadedPlugins())].sort((left, right) => left.id.localeCompare(right.id))
  return triggerPlugins(pointName, input, initial, plugins)
}

export async function triggerForPlugin<Input, Output>(
  pluginId: string,
  pluginGeneration: string,
  pointName: string,
  input: Input,
  initial: Output,
): Promise<Output> {
  const plugin = await getPlugin(pluginId)
  if (!plugin || plugin.manifest.artifacts.generation !== pluginGeneration) return initial
  return triggerPlugins(pointName, input, initial, [plugin])
}

export type PluginHookDeliveryResult =
  | { status: "delivered"; handlerCount: number }
  | { status: "plugin_mismatch" | "no_handler"; handlerCount: 0; error: string }
  | { status: "failed"; handlerCount: number; succeededHandlerCount: number; error: string }

export async function deliverHookForPlugin<Input>(
  pluginId: string,
  pluginGeneration: string,
  pointName: string,
  input: Input,
): Promise<PluginHookDeliveryResult> {
  const point = PluginHookPointRegistry.get(pointName)
  if (point.mode !== "observer")
    throw new Error(`Hook delivery acknowledgment requires an observer point: ${pointName}`)

  const plugin = await getPlugin(pluginId)
  if (!plugin || plugin.manifest.artifacts.generation !== pluginGeneration) {
    return {
      status: "plugin_mismatch",
      handlerCount: 0,
      error: `Plugin ${pluginId} generation ${pluginGeneration} is not active`,
    }
  }

  const result = await executePluginHooks(pointName, input, undefined, [plugin])
  if (result.matchedHandlers === 0) {
    return {
      status: "no_handler",
      handlerCount: 0,
      error: `Plugin ${pluginId} has no handler for ${pointName}`,
    }
  }
  if (result.errors.length > 0) {
    return {
      status: "failed",
      handlerCount: result.matchedHandlers,
      succeededHandlerCount: result.succeededHandlers,
      error: result.errors.join("; "),
    }
  }
  return { status: "delivered", handlerCount: result.succeededHandlers }
}

export async function init() {
  const plugins = await state().then((value) => value.loaded)
  for (const plugin of plugins) {
    const declarations = mcpDeclarations(plugin)
    if (Object.keys(declarations).length > 0) {
      void startForPlugin(plugin.id, declarations).catch((error) =>
        log.error("plugin MCP start failed", { pluginId: plugin.id, error }),
      )
    }
  }
  await LightLoopRuntime.reattachPluginTimers()
  await BlueprintLoopRuntime.reattachPluginTimers()
}

export async function reload() {
  const plugins = await state()
    .then((value) => [...value.loaded])
    .catch(() => [])
  for (const plugin of plugins) {
    await Promise.all([
      stopForPlugin(plugin.id).catch(() => undefined),
      pluginRuntimeManager.stop(plugin.id).catch(() => undefined),
    ])
  }
  await resetAllPluginState()
  const [{ Agent }, { ToolRegistry }] = await Promise.all([import("../agent/agent"), import("../tool/registry")])
  await Promise.all([Agent.reload(), ToolRegistry.reload()])
  await LightLoopRuntime.reattachPluginTimers()
  await BlueprintLoopRuntime.reattachPluginTimers()
}

export async function reloadMcpContributions() {
  for (const plugin of await getLoadedPlugins()) {
    const declarations = mcpDeclarations(plugin)
    if (Object.keys(declarations).length > 0) await startForPlugin(plugin.id, declarations)
  }
}

export async function notifyConfigHooks(input: {
  source: "startup" | "reload" | "plugin_reload"
  config?: Config.Info
  changedFields?: string[]
}) {
  const config = Config.redactForClient(input.config ?? (await Config.current()))
  await trigger(
    "config.changed",
    {
      source: input.source,
      scopeId: ScopeContext.current.scope.id,
      changedFields: input.changedFields,
      timestamp: Date.now(),
      config,
    },
    {},
  )
}

export async function manifest(pluginId: string) {
  return (await getPlugin(pluginId))?.manifest ?? null
}
