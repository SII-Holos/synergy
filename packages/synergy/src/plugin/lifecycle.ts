import type { PluginHooks } from "@ericsanchezok/synergy-plugin"
import { Config } from "../config/config"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { Instance } from "../scope/instance"
import { startForPlugin, stopForPlugin } from "./mcp"
import * as ManifestReader from "./manifest-reader"
import { state, getPlugin, incrementReloadVersion } from "./loader"
import { restoreRuntimeState } from "../plugin-runtime/supervisor.js"
import { PluginToolId } from "./ids"

const log = Log.create({ service: "plugin.lifecycle" })

// ---------------------------------------------------------------------------
// Hook triggering — unchanged interface for all existing consumers
// ---------------------------------------------------------------------------

export async function trigger<
  Name extends Exclude<
    keyof Required<PluginHooks>,
    "auth" | "event" | "tool" | "cli" | "skills" | "agents" | "dispose"
  >,
  Input = Parameters<Required<PluginHooks>[Name]>[0],
  Output = Parameters<Required<PluginHooks>[Name]>[1],
>(name: Name, input: Input, output: Output): Promise<Output> {
  if (!name) return output
  const isToolHook = name === "tool.execute.before" || name === "tool.execute.after"
  const isPermissionAsk = name === "permission.ask"
  for (const { id, hooks, pluginDir } of await state().then((x) => x.loaded)) {
    const fn = hooks[name]
    if (!fn) continue

    // Hook gating: scope filtering from manifest permissions.hooks
    if (isToolHook) {
      const manifest = await ManifestReader.read(pluginDir)
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
          const toolName = toolId ? (PluginToolId.is(toolId) ? PluginToolId.parse(toolId)?.toolId : toolId) : undefined
          const declared = manifest?.contributes?.tools?.some((t) => t.name === toolName || t.id === toolName)
          if (!declared) continue
        } else {
          // "none" or unrecognized: skip
          continue
        }
      }
    }

    if (isPermissionAsk) {
      const manifest = await ManifestReader.read(pluginDir)
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

    // @ts-expect-error - hook signature variance
    await fn(input, output)
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
    for (const { hooks, id } of current.loaded) {
      await stopForPlugin(id).catch((err) => log.error("plugin mcp stop error", { id, err }))
      if (hooks.dispose) {
        log.info("disposing plugin", { id })
        await hooks.dispose().catch((err) => log.error("plugin dispose error", { id, err }))
      }
    }
  }
  await state.resetAll()
  log.info("plugin state reloaded")
}

export async function init() {
  await restoreRuntimeState()
  const config = await Config.get()

  const loaded = await state().then((x) => x.loaded)
  for (const { id, hooks } of loaded) {
    await hooks.config?.(config)
    const m = await manifest(id)
    if (m?.contributes?.mcp) {
      // Plugin-contributed MCP servers may spawn network-backed `npx` processes.
      // Start them in the background so server readiness, channel bootstrap, and the UI banner are not blocked.
      void startForPlugin(id, m.contributes.mcp).catch((err) => log.error("plugin mcp start error", { id, err }))
    }
  }
  const pluginEventState = Instance.state(
    () => {
      const unsub = Bus.subscribeAll(async (input) => {
        const loaded = await state().then((x) => x.loaded)
        for (const { hooks } of loaded) {
          hooks["event"]?.({ event: input })
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
  return ManifestReader.read(plugin.pluginDir)
}
