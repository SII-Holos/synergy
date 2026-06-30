import type {
  PluginDescriptor,
  PluginHooks,
  PluginInput,
  PluginCLIEntry,
  PluginSkill,
  PluginAgent,
} from "@ericsanchezok/synergy-plugin"
import path from "path"
import { fileURLToPath } from "url"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import { BunProc } from "../util/bun"
import { PluginSpec } from "../util/plugin-spec"
import { ScopeContext } from "../scope/context"
import { ScopedState } from "../scope/scoped-state"
import { Global } from "../global"
import { createConfigAccessor, createAuthStore, createCacheStore } from "./store"
import { StartupReporter } from "../cli/startup-reporter"
import { Installation } from "../global/installation"
import type { RuntimeMode } from "../plugin-runtime/registry"
import { resolveInstalledPluginPolicy, type PluginSource } from "./trust"
import { assertCanonicalPluginIdentity, findPackageRoot, importUrlForEntry, resolvePluginSpec } from "./spec-resolver"
import * as Lockfile from "./lockfile"

const log = Log.create({ service: "plugin.loader" })
// ---------------------------------------------------------------------------
// Reload version for local plugin cache-busting
// ---------------------------------------------------------------------------

let reloadVersion = 0

/** Increment the reload version. Called by lifecycle.reload() before resetting state. */
export function incrementReloadVersion(): void {
  reloadVersion++
  specToPluginId.clear()
}

// ---------------------------------------------------------------------------
// Imported plugin types
// ---------------------------------------------------------------------------

export interface LoadedPlugin {
  id: string
  name?: string
  hooks: PluginHooks
  pluginDir: string
  entryPath?: string
  source?: PluginSource
  runtimeMode?: RuntimeMode
  cli?: Record<string, PluginCLIEntry>
  skills?: PluginSkill[]
  agents?: Record<string, PluginAgent>
}

export { findPackageRoot }

/** Resolve a config plugin spec to the package root Synergy should load from. */
export function resolveSpecPluginDir(spec: string): string {
  if (spec.startsWith("file://")) {
    let filePath: string
    try {
      filePath = fileURLToPath(spec)
    } catch {
      filePath = spec.slice("file://".length)
    }
    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(ScopeContext.current.directory, filePath)
    return findPackageRoot(absolute)
  }
  const { pkg } = PluginSpec.parse(spec)
  const nonRegistry = PluginSpec.isNonRegistry(spec)
  const resolvedDir = path.join(Global.Path.cache, "node_modules", nonRegistry ? BunProc.resolvePkgName(pkg) : pkg)
  return findPackageRoot(resolvedDir)
}

const printedPluginIds = new Set<string>()
const printedPluginPaths = new Set<string>()

export interface LoaderState {
  loaded: LoadedPlugin[]
}

export interface ResolvedLoadCandidate {
  configPath: string
  name: string
  showInstallUI: boolean
  resolved: Awaited<ReturnType<typeof resolvePluginSpec>>
  pluginId?: string
}

export function selectLoadCandidates(
  candidates: ResolvedLoadCandidate[],
  lockfile: Awaited<ReturnType<typeof Lockfile.read>> | null,
): ResolvedLoadCandidate[] {
  const selected = new Set<ResolvedLoadCandidate>()
  const byPluginId = new Map<string, ResolvedLoadCandidate>()

  for (const candidate of candidates) {
    const pluginId = candidate.pluginId
    if (!pluginId) {
      selected.add(candidate)
      continue
    }

    const current = byPluginId.get(pluginId)
    if (!current) {
      byPluginId.set(pluginId, candidate)
      selected.add(candidate)
      continue
    }

    const lockSpec = lockfile?.plugins[pluginId]?.spec
    const keep = lockSpec === current.configPath ? current : lockSpec === candidate.configPath ? candidate : candidate
    const drop = keep === current ? candidate : current
    selected.delete(drop)
    selected.add(keep)
    byPluginId.set(pluginId, keep)
    log.warn("duplicate plugin config spec skipped", {
      pluginId,
      kept: keep.configPath,
      skipped: drop.configPath,
      reason: lockSpec ? "lockfile" : "last-config-spec",
    })
  }

  return candidates.filter((candidate) => selected.has(candidate))
}

export const state = ScopedState.create(async (): Promise<LoaderState> => {
  const config = await Config.current()
  const loaded: LoadedPlugin[] = []
  const pluginPaths = [...(config.plugin ?? [])]

  if (pluginPaths.length === 0) return { loaded }

  const { Server } = await import("../server/server")
  const client = createSynergyClient({
    baseUrl: Server.url().toString(),
    // @ts-ignore - fetch type incompatibility
    fetch: async (...args) => Server.App().fetch(...args),
  })
  const baseInput: Omit<PluginInput, "config" | "auth" | "cache" | "pluginDir"> = {
    client,
    scope: ScopeContext.current.scope,
    worktree: ScopeContext.current.worktree,
    directory: ScopeContext.current.directory,
    serverUrl: Server.url(),
    $: Bun.$,
  }

  const candidates: ResolvedLoadCandidate[] = []
  for (const configPath of pluginPaths) {
    log.info("loading plugin", { path: configPath })
    const name = PluginSpec.displayName(configPath)
    const showInstallUI = !printedPluginPaths.has(configPath)

    let resolved: Awaited<ReturnType<typeof resolvePluginSpec>>
    try {
      if (showInstallUI) {
        StartupReporter.active()?.plugin({ name, status: "loaded" })
      }
      resolved = await resolvePluginSpec(configPath, {
        cwd: ScopeContext.current.directory,
        install: !configPath.startsWith("file://"),
      })
      if (showInstallUI) {
        StartupReporter.active()?.plugin({ name, status: resolved.cached ? "cached" : "installed" })
      }
    } catch (err: any) {
      if (showInstallUI) {
        StartupReporter.active()?.plugin({ name, status: "failed", error: err.message ?? String(err) })
      }
      log.warn("plugin resolve failed, skipping", { name, error: err.message ?? err })
      continue
    }

    if (showInstallUI) {
      printedPluginPaths.add(configPath)
    }

    candidates.push({
      configPath,
      name,
      showInstallUI,
      resolved,
      pluginId: resolved.manifest.name,
    })
  }

  const lockfile = await Lockfile.read().catch(() => null)
  const loadedPluginIds = new Set<string>()
  for (const candidate of selectLoadCandidates(candidates, lockfile)) {
    const { configPath, resolved } = candidate

    const importUrl = importUrlForEntry(resolved.entryPath, reloadVersion)
    const mod = await import(importUrl)

    const seen = new Set<PluginDescriptor>()

    for (const [, descriptor] of Object.entries<PluginDescriptor>(mod)) {
      if (!descriptor || typeof descriptor !== "object" || !descriptor.id || !descriptor.init) continue
      if (seen.has(descriptor)) continue
      seen.add(descriptor)
      assertCanonicalPluginIdentity({ spec: configPath, manifest: resolved.manifest, descriptor })

      const pluginId = descriptor.id
      if (loadedPluginIds.has(pluginId)) {
        log.warn("duplicate plugin descriptor skipped", { pluginId, path: configPath })
        continue
      }
      loadedPluginIds.add(pluginId)
      const showLoadedUI = !printedPluginIds.has(pluginId)
      const policy = await resolveInstalledPluginPolicy({
        pluginId,
        pluginDir: resolved.pluginDir,
        manifest: resolved.manifest,
        source: resolved.source,
        devMode: Installation.CHANNEL === "local",
        policy: config.pluginRuntimePolicy,
      })

      const input: PluginInput = {
        ...baseInput,
        pluginDir: resolved.pluginDir,
        config: createConfigAccessor(pluginId),
        auth: createAuthStore(pluginId),
        cache: createCacheStore(pluginId),
      }
      const hooks = await descriptor.init(input)
      loaded.push({
        id: pluginId,
        name: descriptor.name,
        hooks,
        pluginDir: resolved.pluginDir,
        entryPath: resolved.entryPath,
        source: resolved.source,
        runtimeMode: policy.runtimeMode,
        cli: hooks.cli,
        skills: hooks.skills,
        agents: hooks.agents,
      })
      specToPluginId.set(configPath, pluginId)

      if (showLoadedUI) {
        printedPluginIds.add(pluginId)
        StartupReporter.active()?.plugin({ name: descriptor.name ?? pluginId, status: "loaded" })
      }
      log.info("loaded plugin", {
        id: pluginId,
        name: descriptor.name,
        pluginDir: resolved.pluginDir,
        runtimeMode: policy.runtimeMode,
      })
    }
  }

  return { loaded }
})

// ---------------------------------------------------------------------------
// Accessor helpers — used by both lifecycle and install modules
// ---------------------------------------------------------------------------

export async function getLoadedPlugins(): Promise<LoadedPlugin[]> {
  return state().then((x) => x.loaded)
}

export async function getPlugin(pluginId: string): Promise<LoadedPlugin | undefined> {
  return state().then((x) => x.loaded.find((p) => p.id === pluginId))
}

export async function getHooks(): Promise<
  Array<{
    id: string
    hooks: PluginHooks
    pluginDir: string
    entryPath?: string
    source?: PluginSource
    runtimeMode?: RuntimeMode
  }>
> {
  return state().then((x) =>
    x.loaded.map((p) => ({
      id: p.id,
      hooks: p.hooks,
      pluginDir: p.pluginDir,
      entryPath: p.entryPath,
      source: p.source,
      runtimeMode: p.runtimeMode,
    })),
  )
}

export async function getHooksList() {
  return state().then((x) => x.loaded.map((p) => p.hooks))
}

export async function getDescriptors() {
  return state().then((x) => x.loaded.map((p) => ({ id: p.id, name: p.name })))
}

export async function getCliEntries(): Promise<Array<{ pluginId: string; commands: Record<string, PluginCLIEntry> }>> {
  const result: Array<{ pluginId: string; commands: Record<string, PluginCLIEntry> }> = []
  for (const p of await state().then((x) => x.loaded)) {
    if (p.cli && Object.keys(p.cli).length > 0) {
      result.push({ pluginId: p.id, commands: p.cli })
    }
  }
  return result
}

export async function getSkillEntries(): Promise<Array<PluginSkill & { pluginDir: string }>> {
  const result: Array<PluginSkill & { pluginDir: string }> = []
  for (const p of await state().then((x) => x.loaded)) {
    if (p.skills) {
      for (const skill of p.skills) {
        result.push({ ...skill, pluginDir: p.pluginDir })
      }
    }
  }
  return result
}

export async function getAgentEntries(): Promise<Record<string, PluginAgent>> {
  const result: Record<string, PluginAgent> = {}
  for (const p of await state().then((x) => x.loaded)) {
    if (p.agents) Object.assign(result, p.agents)
  }
  return result
}

/** Look up a config spec string to the matching loaded plugin (if any). */
export const specToPluginId = new Map<string, string>()

export async function lookupSpec(spec: string): Promise<LoadedPlugin | undefined> {
  const pluginId = specToPluginId.get(spec)
  if (pluginId) return getPlugin(pluginId)

  const loaded = await getLoadedPlugins()
  const expectedDir = (await resolvePluginSpec(spec, { cwd: ScopeContext.current.directory, install: false })).pluginDir
  return loaded.find((p) => p.pluginDir === expectedDir)
}
