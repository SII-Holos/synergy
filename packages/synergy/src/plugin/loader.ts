import path from "path"
import { fileURLToPath } from "url"
import { pathToFileURL } from "url"
import type {
  PluginAgent,
  PluginManifestContribution,
  PluginManifestType,
  PluginSkill,
} from "@ericsanchezok/synergy-plugin"
import { Config } from "../config/config"
import { Global } from "../global"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { BunProc } from "../util/bun"
import { Log } from "../util/log"
import { PluginSpec } from "../util/plugin-spec"
import { pluginRuntimeManager } from "./runtime"
import type { PluginSource } from "./trust"
import {
  archiveCacheDir,
  findPackageRoot,
  isArchivePath,
  resolvePluginSpec,
  type ResolvedPluginSpec,
} from "./spec-resolver"
import * as Lockfile from "./lockfile"
import { stopForPlugin } from "./mcp"
import { pluginContributionAdapters } from "./contribution-registry"
import { getApproval, verifyApproval } from "./consent/approval-store"

const log = Log.create({ service: "plugin.catalog" })

export interface LoadedPlugin {
  id: string
  name: string
  manifest: PluginManifestType
  pluginDir: string
  entryPath?: string
  source: PluginSource
  spec: string
  enabledScopes: Set<string>
  contributionHealth: Map<string, { state: "healthy" | "degraded"; lastError?: string; updatedAt: number }>
}

export type DisabledPluginPhase = "resolve" | "manifest" | "runtime" | "contribution" | "doctor"

export interface DisabledPlugin {
  pluginId: string
  name?: string
  spec?: string
  pluginDir?: string
  entryPath?: string
  source?: PluginSource
  phase: DisabledPluginPhase
  reason: string
  disabledAt: number
}

export interface LoaderState {
  loaded: LoadedPlugin[]
  disabled: DisabledPlugin[]
  scopeId: string
}

const catalog = new Map<string, LoadedPlugin>()
const specToPluginId = new Map<string, string>()

export { findPackageRoot, specToPluginId }

export function resolveSpecPluginDir(spec: string): string {
  if (spec.startsWith("file://")) {
    let filePath: string
    try {
      filePath = fileURLToPath(spec)
    } catch {
      filePath = spec.slice("file://".length)
    }
    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(ScopeContext.current.directory, filePath)
    if (isArchivePath(absolute)) return archiveCacheDir(absolute)
    const root = findPackageRoot(absolute)
    return Bun.file(path.join(root, "dist", "plugin.json")).size > 0 ? path.join(root, "dist") : root
  }
  const { pkg } = PluginSpec.parse(spec)
  const resolvedDir = path.join(
    Global.Path.cache,
    "node_modules",
    PluginSpec.isNonRegistry(spec) ? BunProc.resolvePkgName(pkg) : pkg,
  )
  return findPackageRoot(resolvedDir)
}

function registerResolved(spec: string, resolved: ResolvedPluginSpec): LoadedPlugin {
  const manifest = resolved.manifest
  const existing = catalog.get(manifest.id)
  if (existing) {
    pluginContributionAdapters.registerPlugin(manifest.id, manifest)
    existing.name = manifest.name
    existing.manifest = manifest
    existing.pluginDir = resolved.pluginDir
    existing.entryPath = resolved.entryPath
    existing.source = resolved.source
    existing.spec = spec
    specToPluginId.set(spec, manifest.id)
    return existing
  }
  const plugin: LoadedPlugin = {
    id: manifest.id,
    name: manifest.name,
    manifest,
    pluginDir: resolved.pluginDir,
    entryPath: resolved.entryPath,
    source: resolved.source,
    spec,
    enabledScopes: new Set(),
    contributionHealth: new Map(),
  }
  catalog.set(plugin.id, plugin)
  pluginContributionAdapters.registerPlugin(plugin.id, manifest)
  specToPluginId.set(spec, plugin.id)
  return plugin
}

function disabled(input: Omit<DisabledPlugin, "disabledAt">): DisabledPlugin {
  return { ...input, disabledAt: Date.now() }
}

export const state = ScopedState.create(
  async (): Promise<LoaderState> => {
    const scopeId = ScopeContext.current.scope.id
    const config = await Config.current()
    const loaded: LoadedPlugin[] = []
    const failures: DisabledPlugin[] = []
    const lockfile = await Lockfile.read().catch(() => null)
    const selected = new Map<string, { spec: string; resolved: ResolvedPluginSpec }>()

    for (const spec of config.plugin ?? []) {
      try {
        const resolved = await resolvePluginSpec(spec, {
          cwd: ScopeContext.current.directory,
          install: !spec.startsWith("file://"),
        })
        const approval = await getApproval(resolved.manifest.id, resolved.manifest)
        if (!approval || !verifyApproval(approval, resolved.manifest)) {
          throw new Error(`Plugin ${resolved.manifest.id}@${resolved.manifest.version} requires capability approval`)
        }
        const current = selected.get(resolved.manifest.id)
        const lockedSpec = lockfile?.plugins[resolved.manifest.id]?.spec
        if (!current || lockedSpec === spec) {
          selected.set(resolved.manifest.id, { spec, resolved })
        }
      } catch (error) {
        failures.push(
          disabled({
            pluginId: PluginSpec.displayName(spec),
            spec,
            phase: "resolve",
            reason: error instanceof Error ? error.message : String(error),
          }),
        )
      }
    }

    for (const { spec, resolved } of selected.values()) {
      const plugin = registerResolved(spec, resolved)
      plugin.enabledScopes.add(scopeId)
      loaded.push(plugin)
      log.info("plugin enabled", {
        pluginId: plugin.id,
        version: plugin.manifest.version,
        generation: plugin.manifest.artifacts.generation,
        scopeId,
      })
    }
    return { loaded, disabled: failures, scopeId }
  },
  async (current) => {
    for (const plugin of current.loaded) {
      plugin.enabledScopes.delete(current.scopeId)
      if (plugin.enabledScopes.size > 0) continue
      await Promise.all([
        pluginRuntimeManager.stop(plugin.id).catch(() => undefined),
        stopForPlugin(plugin.id).catch(() => undefined),
      ])
    }
  },
)

export async function getLoadedPlugins() {
  return state().then((value) => value.loaded)
}

export async function getDisabledPlugins() {
  return state().then((value) => value.disabled)
}

export async function getPlugin(pluginId: string) {
  return state().then((value) => value.loaded.find((plugin) => plugin.id === pluginId))
}

export async function reloadDevelopmentGeneration(input: {
  pluginId: string
  generation: string
  artifactDir: string
}) {
  const current = await getPlugin(input.pluginId)
  if (!current) throw new Error(`Plugin is not enabled in this Scope: ${input.pluginId}`)
  if (current.source !== "local") throw new Error("Development reload is only available for local plugins")
  const resolved = await resolvePluginSpec(pathToFileURL(path.resolve(input.artifactDir)).href, {
    cwd: ScopeContext.current.directory,
    install: false,
  })
  if (resolved.manifest.id !== input.pluginId) throw new Error("Development generation plugin id mismatch")
  if (resolved.manifest.artifacts.generation !== input.generation) {
    throw new Error("Development generation manifest mismatch")
  }
  if (resolved.entryPath) {
    await pluginRuntimeManager.start({
      manifest: resolved.manifest,
      pluginDir: resolved.pluginDir,
      entryPath: resolved.entryPath,
    })
  }
  return registerResolved(current.spec, resolved)
}

export function getCatalogPlugin(pluginId: string) {
  return catalog.get(pluginId)
}

export async function getDisabledPlugin(pluginId: string) {
  return state().then((value) => value.disabled.find((plugin) => plugin.pluginId === pluginId))
}

export async function disablePlugin(input: {
  pluginId: string
  phase: DisabledPluginPhase
  reason: string
  spec?: string
  pluginDir?: string
  entryPath?: string
  source?: PluginSource
  name?: string
}) {
  const current = await state()
  const plugin = current.loaded.find((item) => item.id === input.pluginId)
  if (plugin) {
    plugin.enabledScopes.delete(current.scopeId)
    current.loaded = current.loaded.filter((item) => item.id !== input.pluginId)
  }
  const record = disabled({
    ...input,
    name: input.name ?? plugin?.name,
    spec: input.spec ?? plugin?.spec,
    pluginDir: input.pluginDir ?? plugin?.pluginDir,
    entryPath: input.entryPath ?? plugin?.entryPath,
    source: input.source ?? plugin?.source,
  })
  current.disabled = current.disabled.filter((item) => item.pluginId !== input.pluginId)
  current.disabled.push(record)
  return record
}

export async function getDescriptors() {
  return (await getLoadedPlugins()).map((plugin) => ({ id: plugin.id, name: plugin.name }))
}

export async function getSkillEntries(): Promise<
  Array<PluginSkill & { pluginId: string; pluginName?: string; pluginDir: string }>
> {
  return (await getLoadedPlugins()).flatMap((plugin) =>
    contributions(plugin, "skill").map((item) => ({
      ...(item.skill as unknown as PluginSkill),
      name: (item.skill.name as string | undefined) ?? item.id,
      pluginId: plugin.id,
      pluginName: plugin.name,
      pluginDir: plugin.pluginDir,
    })),
  )
}

export async function getAgentEntries(): Promise<Record<string, PluginAgent>> {
  const agents: Record<string, PluginAgent> = {}
  for (const plugin of await getLoadedPlugins()) {
    for (const item of contributions(plugin, "agent")) {
      agents[item.id] = {
        ...(item.agent as unknown as PluginAgent),
        name: (item.agent.name as string | undefined) ?? item.id,
      }
    }
  }
  return agents
}

export async function getAuthProviderEntries() {
  return (await getLoadedPlugins()).flatMap((plugin) =>
    contributions(plugin, "authProvider").map((contribution) => ({ plugin, contribution })),
  )
}

export async function lookupSpec(spec: string) {
  const id = specToPluginId.get(spec)
  if (id) return getPlugin(id)
  const resolved = await resolvePluginSpec(spec, { cwd: ScopeContext.current.directory, install: false })
  return getPlugin(resolved.manifest.id)
}

export function contribution<Kind extends PluginManifestContribution["kind"]>(
  plugin: LoadedPlugin,
  kind: Kind,
  id: string,
): Extract<PluginManifestContribution, { kind: Kind }> | undefined {
  return contributions(plugin, kind).find((item) => item.id === id)
}

export function contributions<Kind extends PluginManifestContribution["kind"]>(
  plugin: LoadedPlugin,
  kind: Kind,
): Array<Extract<PluginManifestContribution, { kind: Kind }>> {
  return pluginContributionAdapters.list(plugin.id, kind)
}

export function markContributionDegraded(plugin: LoadedPlugin, contributionId: string, error: unknown) {
  plugin.contributionHealth.set(contributionId, {
    state: "degraded",
    lastError: error instanceof Error ? error.message : String(error),
    updatedAt: Date.now(),
  })
}

export async function ensureRuntime(plugin: LoadedPlugin) {
  const runtime = plugin.manifest.artifacts.runtime
  if (!runtime || !plugin.entryPath) throw new Error(`Plugin ${plugin.id} has no runtime artifact`)
  return pluginRuntimeManager.start({
    manifest: plugin.manifest,
    pluginDir: plugin.pluginDir,
    entryPath: plugin.entryPath,
  })
}

export async function resetAllPluginState() {
  await state.resetAll()
}
