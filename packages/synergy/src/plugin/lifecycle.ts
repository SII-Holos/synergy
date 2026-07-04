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

// ---------------------------------------------------------------------------
// Hook triggering — unchanged interface for all existing consumers
// ---------------------------------------------------------------------------

export async function trigger<
  Name extends Exclude<
    keyof Required<PluginHooks>,
    "auth" | "provider" | "event" | "tool" | "cli" | "skills" | "agents" | "dispose"
  >,
  Input = Parameters<Required<PluginHooks>[Name]>[0],
  Output = Parameters<Required<PluginHooks>[Name]>[1],
>(name: Name, input: Input, output: Output): Promise<Output> {
  if (!name) return output
  const isToolHook = name === "tool.execute.before" || name === "tool.execute.after"
  const isPermissionAsk = name === "permission.ask"
  for (const plugin of await state().then((x) => [...x.loaded])) {
    const { id, hooks, manifest, runtimeMode } = plugin
    const fn = hooks[name]
    if (!fn) continue

    try {
      // Hook gating: scope filtering from manifest permissions.hooks
      if (isToolHook) {
        const scope = manifest?.permissions?.hooks?.toolExecute ?? "own"
        if (scope !== "all") {
          // "own" scope: only fire if this plugin owns the tool being executed.
          // The input carries the prefixed full tool ID (e.g. plugin__myplugin__mytool).
          const toolId = (input as any)?.tool as string | undefined
          if (scope === "own" && toolId && PluginToolId.is(toolId)) {
            const parsed = PluginToolId.parse(toolId)
            if (parsed?.pluginId !== id) continue
          } else if (scope === "declared") {
            // "declared" scope: fire if the tool is in this plugin's declared contributes.tools
            const toolName = toolId
              ? PluginToolId.is(toolId)
                ? PluginToolId.parse(toolId)?.toolId
                : toolId
              : undefined
            const declared = manifest?.contributes?.tools?.some(
              (tool: { id?: string; name?: string }) => tool.name === toolName || tool.id === toolName,
            )
            if (!declared) continue
          } else {
            // "none" or unrecognized: skip
            continue
          }
        }
      }

      if (isPermissionAsk) {
        const scope = manifest?.permissions?.hooks?.permissionAsk ?? "none"
        if (scope === "none") continue
        if (scope === "own") {
          // "own" scope: only fire for permissions triggered by this plugin's own tools.
          // The input carries the tool name/id.
          const toolId = (input as any)?.tool as string | undefined
          if (toolId && PluginToolId.is(toolId)) {
            const parsed = PluginToolId.parse(toolId)
            if (parsed?.pluginId !== id) continue
          }
        }
      }

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

export async function init() {
  await restoreRuntimeState()
  const config = await Config.current()

  const loaded = await state().then((x) => [...x.loaded])
  const { Server } = await import("../server/server")
  for (const plugin of loaded) {
    const { id, hooks, runtimeMode, source, entryPath, pluginDir, manifest } = plugin
    try {
      await hooks.config?.(config)
    } catch (err) {
      await disableLoadedPlugin(plugin, "hook", err)
      continue
    }
    if (runtimeMode && runtimeMode !== "in-process" && entryPath && source) {
      void startRuntime(id, {
        mode: runtimeMode,
        source,
        entryPath,
        pluginDir,
        scope: ScopeContext.current.scope,
        serverUrl: Server.url().toString(),
      }).catch(async (err) => {
        log.error("plugin runtime start error", { id, err })
        await disableLoadedPlugin(plugin, "runtime", err)
      })
    }
    if (manifest.contributes?.mcp) {
      // Plugin-contributed MCP servers may spawn network-backed `npx` processes.
      // Start them in the background so server readiness, channel bootstrap, and the UI banner are not blocked.
      void startForPlugin(id, manifest.contributes.mcp).catch((err) => log.error("plugin mcp start error", { id, err }))
    }
  }
  const pluginEventState = ScopedState.create(
    () => {
      const unsub = Bus.subscribeAll(async (input) => {
        const loaded = await state().then((x) => [...x.loaded])
        for (const plugin of loaded) {
          try {
            if (!canReceiveEvent(plugin, input.type)) continue
            const fn = plugin.hooks["event"]
            if (!fn) continue
            await withTimeout(Promise.resolve(fn({ event: input })), await hookInvocationTimeoutMs(plugin), {
              message: `Plugin event hook timed out`,
            })
          } catch (err) {
            await disableLoadedPlugin(plugin, "hook", err)
          }
        }
      })
      return { unsub }
    },
    async (s) => s.unsub(),
  )
  void pluginEventState()
}

/** Look up a plugin's manifest — used both internally and re-exported by the facade */
export async function manifest(pluginId: string) {
  const plugin = await getPlugin(pluginId)
  if (!plugin) return null
  return plugin.manifest
}

function canReceiveEvent(plugin: LoadedPlugin, eventName: string): boolean {
  const manifest = plugin.manifest
  const hooks = manifest?.permissions?.hooks
  const mode = hooks?.events ?? "selected"
  if (mode === "all") return true
  if (mode === "none") return false
  return (hooks?.eventNames ?? []).includes(eventName)
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
