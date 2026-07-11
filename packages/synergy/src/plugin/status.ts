import z from "zod"
import { PluginToolId } from "./ids"
import { riskForCapabilities } from "./capability"
import { getDisabledPlugin, getDisabledPlugins, getLoadedPlugins, getPlugin, type LoadedPlugin } from "./loader"
import { pluginRuntimeManager } from "./runtime"

const Source = z.enum(["local", "npm", "git", "url", "builtin", "official"])

export const PluginStatusSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    version: z.string().optional(),
    apiVersion: z.string().optional(),
    generation: z.string().optional(),
    source: Source,
    trust: z.enum(["declarative", "trusted-import"]),
    health: z.enum(["loaded", "disabled"]),
    disabledReason: z.string().optional(),
    disabledPhase: z.string().optional(),
    loaded: z.boolean(),
    capabilities: z.array(z.string()),
    risk: z.enum(["low", "medium", "high"]),
    operations: z.array(z.object({ id: z.string(), type: z.enum(["query", "command"]), expose: z.array(z.string()) })),
    tools: z.array(z.object({ id: z.string(), fullId: z.string(), capabilities: z.array(z.string()) })),
    uiContributions: z.number(),
    contributionHealth: z.record(
      z.string(),
      z.object({ state: z.enum(["healthy", "degraded"]), lastError: z.string().optional(), updatedAt: z.number() }),
    ),
    runtime: z
      .object({
        mode: z.enum(["process", "inProcess"]),
        state: z.enum(["starting", "ready", "draining", "crashed", "stopped"]),
        pid: z.number().optional(),
        inFlight: z.number(),
        lastHeartbeatAt: z.number().optional(),
        lastError: z.string().optional(),
      })
      .optional(),
  })
  .meta({ ref: "PluginStatus" })

export type PluginStatus = z.infer<typeof PluginStatusSchema>

function trustedImport(plugin: LoadedPlugin) {
  return plugin.manifest.contributions.some(
    (item) => item.kind.startsWith("ui.") && "component" in item && Boolean(item.component),
  )
}

export async function getStatusForLoadedPlugin(plugin: LoadedPlugin): Promise<PluginStatus> {
  const capabilities = plugin.manifest.capabilities.map((item) => item.id)
  const runtime = pluginRuntimeManager.registry.active(plugin.id)
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.manifest.version,
    apiVersion: plugin.manifest.apiVersion,
    generation: plugin.manifest.artifacts.generation,
    source: plugin.source,
    trust: trustedImport(plugin) ? "trusted-import" : "declarative",
    health: "loaded",
    loaded: true,
    capabilities,
    risk: riskForCapabilities(capabilities),
    operations: plugin.manifest.contributions
      .filter((item) => item.kind === "operation")
      .map((item) => ({ id: item.id, type: item.type, expose: item.expose })),
    tools: plugin.manifest.contributions
      .filter((item) => item.kind === "tool")
      .map((item) => ({
        id: item.id,
        fullId: PluginToolId.format(plugin.id, item.id),
        capabilities: item.requires ?? [],
      })),
    uiContributions: plugin.manifest.contributions.filter((item) => item.kind.startsWith("ui.")).length,
    contributionHealth: Object.fromEntries(plugin.contributionHealth),
    runtime: runtime
      ? {
          mode: runtime.mode,
          state: runtime.state,
          pid: runtime.process?.process.pid,
          inFlight: runtime.inFlight,
          lastHeartbeatAt: runtime.lastHeartbeatAt,
          lastError: runtime.lastError,
        }
      : undefined,
  }
}

function disabledStatus(plugin: Awaited<ReturnType<typeof getDisabledPlugin>> & {}): PluginStatus {
  return {
    id: plugin.pluginId,
    name: plugin.name ?? plugin.pluginId,
    source: plugin.source ?? "local",
    trust: "declarative",
    health: "disabled",
    disabledReason: plugin.reason,
    disabledPhase: plugin.phase,
    loaded: false,
    capabilities: [],
    risk: "low",
    operations: [],
    tools: [],
    uiContributions: 0,
    contributionHealth: {},
  }
}

export async function getStatus(pluginId: string): Promise<PluginStatus | null> {
  const plugin = await getPlugin(pluginId)
  if (plugin) return getStatusForLoadedPlugin(plugin)
  const disabled = await getDisabledPlugin(pluginId)
  return disabled ? disabledStatus(disabled) : null
}

export async function getAllStatus(): Promise<PluginStatus[]> {
  const loaded = await Promise.all((await getLoadedPlugins()).map(getStatusForLoadedPlugin))
  return [...loaded, ...(await getDisabledPlugins()).map(disabledStatus)]
}
