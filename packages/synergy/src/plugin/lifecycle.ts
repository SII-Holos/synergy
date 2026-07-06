import type { PluginHooks } from "@ericsanchezok/synergy-plugin"
import { Config } from "../config/config"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { startForPlugin, stopForPlugin } from "./mcp"
import { state, getPlugin, incrementReloadVersion, disablePlugin, type LoadedPlugin } from "./loader"
import { restoreRuntimeState, startRuntime, stopRuntime } from "../plugin-runtime/supervisor.js"
import { getRuntime, triggerRuntimeHook } from "../plugin-runtime/supervisor.js"
import { PluginToolId } from "./ids"
import { withTimeout } from "../util/timeout"
import { resolveRuntimeLimits } from "../plugin-runtime/health"

const log = Log.create({ service: "plugin.lifecycle" })
type ConfigHookInput = {
  source: "startup" | "reload" | "plugin_reload"
  scopeID?: string
  scopeType?: string
  changedFields?: string[]
  timestamp: number
}

type ConfigHookOutput = { config: Config.Info }

const pluginEventState = ScopedState.create(
  () => {
    const unsub = Bus.subscribeAll(async (event) => {
      const loaded = await state().then((x) => [...x.loaded])
      for (const plugin of loaded) {
        await notifyEventHook(plugin, event)
      }
    })
    return { unsub }
  },
  async (s) => s.unsub(),
)

// ---------------------------------------------------------------------------
// Hook triggering — unchanged interface for all existing consumers
// ---------------------------------------------------------------------------

export async function trigger<
  Name extends Exclude<
    keyof Required<PluginHooks>,
    "auth" | "provider" | "event" | "config" | "tool" | "cli" | "skills" | "agents" | "dispose"
  >,
  Input = Parameters<Required<PluginHooks>[Name]>[0],
  Output = Parameters<Required<PluginHooks>[Name]>[1],
>(name: Name, input: Input, output: Output): Promise<Output> {
  if (!name) return output
  for (const plugin of await state().then((x) => [...x.loaded])) {
    const { id, hooks, runtimeMode } = plugin
    const fn = hooks[name]
    if (!fn) continue
    if (!canReceiveHook(plugin, String(name), input)) continue

    try {
      if (runtimeMode && runtimeMode !== "in-process") {
        const runtime = getRuntime(id)
        if (runtime?.hooks?.includes(String(name))) {
          const nextOutput = await triggerRuntimeHook(id, String(name), input, output)
          if (nextOutput && typeof nextOutput === "object" && output && typeof output === "object") {
            Object.assign(output as any, nextOutput)
          }
        }
        continue
      }

      // @ts-expect-error - hook signature variance
      await withTimeout(Promise.resolve(fn(input, output)), await hookInvocationTimeoutMs(plugin), {
        message: `Plugin hook "${String(name)}" timed out`,
      })
    } catch (err) {
      await disableLoadedPlugin(plugin, "hook", err)
      continue
    }
  }
  return output
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function reload() {
  log.info("reloading plugin state")
  incrementReloadVersion()
  const current = await state().catch(() => null)
  if (current) {
    for (const { hooks, id, runtimeMode } of current.loaded) {
      await stopForPlugin(id).catch((err) => log.error("plugin mcp stop error", { id, err }))
      if (runtimeMode && runtimeMode !== "in-process") {
        await stopRuntime(id, true).catch((err) => log.error("plugin runtime stop error", { id, err }))
      }
      if (hooks.dispose) {
        log.info("disposing plugin", { id })
        await hooks.dispose().catch((err) => log.error("plugin dispose error", { id, err }))
      }
    }
  }
  await state.resetAll()
  const { ToolRegistry } = await import("../tool/registry")
  await ToolRegistry.reload()
  log.info("plugin state reloaded")
}

export async function init(input: { source?: "startup" | "plugin_reload" } = {}) {
  await restoreRuntimeState()
  const config = await Config.current()

  const loaded = await state().then((x) => [...x.loaded])
  const { Server } = await import("../server/server")
  const runtimeStarts: Promise<void>[] = []
  for (const plugin of loaded) {
    const { id, runtimeMode, source, entryPath, pluginDir, manifest } = plugin
    if (runtimeMode && runtimeMode !== "in-process" && entryPath && source) {
      runtimeStarts.push(
        startRuntime(id, {
          mode: runtimeMode,
          source,
          entryPath,
          pluginDir,
          scope: ScopeContext.current.scope,
          serverUrl: Server.url().toString(),
        })
          .then(() => {})
          .catch(async (err) => {
            log.error("plugin runtime start error", { id, err })
            await disableLoadedPlugin(plugin, "runtime", err)
          }),
      )
    }
    if (manifest.contributes?.mcp) {
      // Plugin-contributed MCP servers may spawn network-backed `npx` processes.
      // Start them in the background so server readiness, channel bootstrap, and the UI banner are not blocked.
      void startForPlugin(id, manifest.contributes.mcp).catch((err) => log.error("plugin mcp start error", { id, err }))
    }
  }
  await Promise.all(runtimeStarts)
  await notifyConfigHooks({ source: input.source ?? "startup", config })
  void pluginEventState()
}

export async function notifyConfigHooks(input: {
  source: "startup" | "reload" | "plugin_reload"
  config?: Config.Info
  changedFields?: string[]
}) {
  const config = input.config ?? (await Config.current())
  const redactedConfig = Config.redactForClient(config)
  const hookInput: ConfigHookInput = {
    source: input.source,
    scopeID: ScopeContext.current.scope.id,
    scopeType: ScopeContext.current.scope.type,
    changedFields: input.changedFields,
    timestamp: Date.now(),
  }
  for (const plugin of await state().then((x) => [...x.loaded])) {
    if (!canReceiveConfig(plugin)) continue
    const output = { config: immutableConfigSnapshot(redactedConfig) }
    try {
      if (plugin.runtimeMode && plugin.runtimeMode !== "in-process") {
        const runtime = getRuntime(plugin.id)
        if (runtime?.hooks?.includes("config")) {
          await triggerRuntimeHook(plugin.id, "config", hookInput, output)
        }
        continue
      }
      const fn = plugin.hooks.config as
        | ((input: ConfigHookInput, output: ConfigHookOutput) => Promise<void>)
        | undefined
      if (!fn) continue
      await withTimeout(Promise.resolve(fn(hookInput, output)), await hookInvocationTimeoutMs(plugin), {
        message: `Plugin config hook timed out`,
      })
    } catch (err) {
      await disableLoadedPlugin(plugin, "hook", err)
    }
  }
}

/** Look up a plugin's manifest — used both internally and re-exported by the facade */
export async function manifest(pluginId: string) {
  const plugin = await getPlugin(pluginId)
  if (!plugin) return null
  return plugin.manifest
}

function canReceiveHook(plugin: LoadedPlugin, name: string, input: unknown): boolean {
  const hooks = plugin.manifest?.permissions?.hooks
  if (name === "tool.execute.before" || name === "tool.execute.after") return canReceiveToolHook(plugin, input)
  if (name === "permission.ask") return canReceivePermissionAsk(plugin, input)
  if (name === "experimental.chat.system.transform" || name === "experimental.chat.messages.transform") {
    return hooks?.promptTransform === true
  }
  if (name === "experimental.session.compacting") return hooks?.compactionTransform === true
  return true
}

function canReceiveToolHook(plugin: LoadedPlugin, input: unknown): boolean {
  const scope = plugin.manifest?.permissions?.hooks?.toolExecute ?? "own"
  if (scope === "all") return true
  const toolId = (input as any)?.tool as string | undefined
  if (scope === "own" && toolId && PluginToolId.is(toolId)) {
    return PluginToolId.parse(toolId)?.pluginId === plugin.id
  }
  if (scope === "declared") {
    const toolName = toolId ? (PluginToolId.is(toolId) ? PluginToolId.parse(toolId)?.toolId : toolId) : undefined
    return Boolean(
      toolName &&
        plugin.manifest?.contributes?.tools?.some(
          (tool: { id?: string; name?: string }) => tool.name === toolName || tool.id === toolName,
        ),
    )
  }
  return false
}

function canReceivePermissionAsk(plugin: LoadedPlugin, input: unknown): boolean {
  const scope = plugin.manifest?.permissions?.hooks?.permissionAsk ?? "none"
  if (scope === "none") return false
  if (scope === "all") return true
  const toolId = (input as any)?.tool as string | undefined
  if (!toolId || !PluginToolId.is(toolId)) return false
  return PluginToolId.parse(toolId)?.pluginId === plugin.id
}

function canReceiveConfig(plugin: LoadedPlugin): boolean {
  return plugin.manifest?.permissions?.hooks?.config === true
}

function canReceiveEvent(plugin: LoadedPlugin, eventName: string): boolean {
  const hooks = plugin.manifest?.permissions?.hooks
  const mode = hooks?.events ?? "selected"
  if (mode === "all") return true
  if (mode === "none") return false
  return (hooks?.eventNames ?? []).some((pattern: string) => eventNameMatches(pattern, eventName))
}

function eventNameMatches(pattern: string, eventName: string): boolean {
  if (pattern === "*") return true
  if (pattern.endsWith(".*")) return eventName.startsWith(`${pattern.slice(0, -2)}.`)
  return pattern === eventName
}

async function notifyEventHook(plugin: LoadedPlugin, event: { type: string; properties: unknown }) {
  if (!canReceiveEvent(plugin, event.type)) return
  try {
    if (plugin.runtimeMode && plugin.runtimeMode !== "in-process") {
      const runtime = getRuntime(plugin.id)
      if (runtime?.hooks?.includes("event")) {
        await triggerRuntimeHook(plugin.id, "event", { event }, {})
      }
      return
    }
    const fn = plugin.hooks.event as
      | ((input: { event: { type: string; properties: unknown } }) => Promise<void>)
      | undefined
    if (!fn) return
    await withTimeout(Promise.resolve(fn({ event })), await hookInvocationTimeoutMs(plugin), {
      message: `Plugin event hook timed out`,
    })
  } catch (err) {
    await disableLoadedPlugin(plugin, "hook", err)
  }
}

function immutableConfigSnapshot(config: Config.Info): Config.Info {
  return deepFreeze(structuredClone(config))
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") return value
  for (const nested of Object.values(value)) {
    deepFreeze(nested)
  }
  return Object.freeze(value)
}

async function hookInvocationTimeoutMs(plugin: LoadedPlugin): Promise<number> {
  const config = await Config.current().catch(() => undefined)
  return resolveRuntimeLimits(config?.pluginRuntimePolicy?.limits, plugin.manifest.runtime?.resources)
    .hookInvocationTimeoutMs
}

async function disableLoadedPlugin(plugin: LoadedPlugin, phase: "hook" | "runtime", err: unknown) {
  const reason = err instanceof Error ? err.message : String(err)
  await disablePlugin({
    pluginId: plugin.id,
    name: plugin.name,
    pluginDir: plugin.pluginDir,
    entryPath: plugin.entryPath,
    source: plugin.source,
    phase,
    reason,
  })
  if (plugin.runtimeMode && plugin.runtimeMode !== "in-process") {
    await stopRuntime(plugin.id, true).catch((stopErr) =>
      log.error("plugin runtime stop after disable error", { id: plugin.id, err: stopErr }),
    )
  }
  const { ToolRegistry } = await import("../tool/registry")
  await ToolRegistry.reload().catch((reloadErr) =>
    log.error("tool registry reload after plugin disable error", { id: plugin.id, err: reloadErr }),
  )
}
