import path from "path"
import { fileURLToPath } from "url"
import z from "zod"
import { PluginToolId } from "./ids"
import { riskForCapabilities } from "./capability"
import { getDisabledPlugin, getDisabledPlugins, getLoadedPlugins, getPlugin, type LoadedPlugin } from "./loader"
import { pluginRuntimeManager } from "./runtime"
import type { PluginSource } from "./trust"
import { sourceFromSpec } from "./source"
import { isArchivePath } from "./spec-resolver"
import { localRegistryStoreDir } from "./local-registry-store"
import { isPathContained } from "../util/path-contain"

export const PluginInstallationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("directory"), spec: z.string(), path: z.string() }),
  z.object({ kind: z.literal("archive"), spec: z.string(), path: z.string() }),
  z.object({
    kind: z.literal("registry"),
    registry: z.enum(["official", "local"]),
    spec: z.string(),
  }),
  z.object({
    kind: z.literal("package"),
    source: z.enum(["npm", "git", "url"]),
    spec: z.string(),
  }),
  z.object({ kind: z.literal("builtin"), spec: z.string() }),
])

export type PluginInstallation = z.infer<typeof PluginInstallationSchema>

function localSpecPath(spec: string): string | undefined {
  if (!spec.startsWith("file://")) return undefined
  try {
    return path.resolve(fileURLToPath(spec))
  } catch {
    return path.resolve(spec.slice("file://".length))
  }
}

export function classifyPluginInstallation(input: {
  spec: string
  source?: PluginSource
  pluginDir?: string
}): PluginInstallation {
  const source = input.source ?? sourceFromSpec(input.spec)
  if (source === "official") return { kind: "registry", registry: "official", spec: input.spec }
  if (source === "builtin") return { kind: "builtin", spec: input.spec }
  if (source === "npm" || source === "git" || source === "url") {
    return { kind: "package", source, spec: input.spec }
  }

  const localPath = localSpecPath(input.spec) ?? path.resolve(input.pluginDir ?? input.spec)
  if (isPathContained(localRegistryStoreDir(), localPath)) {
    return { kind: "registry", registry: "local", spec: input.spec }
  }
  if (isArchivePath(localPath)) return { kind: "archive", spec: input.spec, path: localPath }
  return { kind: "directory", spec: input.spec, path: path.resolve(input.pluginDir ?? localPath) }
}

export const PluginStatusSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    version: z.string().optional(),
    apiVersion: z.string().optional(),
    generation: z.string().optional(),
    installation: PluginInstallationSchema,
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
    installation: classifyPluginInstallation(plugin),
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
  if (plugin.phase === "approval" && plugin.manifest) {
    const manifest = plugin.manifest
    const capabilities = manifest.capabilities.map((item) => item.id)
    const trusted = manifest.contributions.some(
      (item) => item.kind.startsWith("ui.") && "component" in item && Boolean(item.component),
    )
    return {
      id: plugin.pluginId,
      name: plugin.name ?? plugin.pluginId,
      version: manifest.version,
      apiVersion: manifest.apiVersion,
      generation: manifest.artifacts.generation,
      installation: classifyPluginInstallation({ spec: plugin.spec ?? plugin.pluginId, source: plugin.source }),
      trust: trusted ? "trusted-import" : "declarative",
      health: "disabled",
      disabledReason: plugin.reason,
      disabledPhase: plugin.phase,
      loaded: false,
      capabilities,
      risk: riskForCapabilities(capabilities),
      operations: manifest.contributions
        .filter((item) => item.kind === "operation")
        .map((item) => ({ id: item.id, type: item.type as "query" | "command", expose: item.expose })),
      tools: manifest.contributions
        .filter((item) => item.kind === "tool")
        .map((item) => ({
          id: item.id,
          fullId: PluginToolId.format(plugin.pluginId, item.id),
          capabilities: item.requires ?? [],
        })),
      uiContributions: manifest.contributions.filter((item) => item.kind.startsWith("ui.")).length,
      contributionHealth: {},
    }
  }
  return {
    id: plugin.pluginId,
    name: plugin.name ?? plugin.pluginId,
    installation: classifyPluginInstallation({
      spec: plugin.spec ?? plugin.pluginDir ?? plugin.pluginId,
      source: plugin.source,
      pluginDir: plugin.pluginDir,
    }),
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
