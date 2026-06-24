import type {
  PluginDescriptor,
  PluginHooks,
  PluginInput,
  PluginCLIEntry,
  PluginSkill,
  PluginAgent,
} from "@ericsanchezok/synergy-plugin"
import path from "path"
import { existsSync } from "fs"
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

const log = Log.create({ service: "plugin.loader" })
// ---------------------------------------------------------------------------
// Reload version for local plugin cache-busting
// ---------------------------------------------------------------------------

let reloadVersion = 0

/** Increment the reload version. Called by lifecycle.reload() before resetting state. */
export function incrementReloadVersion(): void {
  reloadVersion++
}

// ---------------------------------------------------------------------------
// Imported plugin types
// ---------------------------------------------------------------------------

export interface LoadedPlugin {
  id: string
  name?: string
  hooks: PluginHooks
  pluginDir: string
  cli?: Record<string, PluginCLIEntry>
  skills?: PluginSkill[]
  agents?: Record<string, PluginAgent>
}

/** Walk up from a file path to find the nearest directory containing package.json. */
export function findPackageRoot(entryPath: string): string {
  let dir = existsSync(path.join(entryPath, "package.json")) ? entryPath : path.dirname(entryPath)
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, "package.json"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.dirname(entryPath)
}

/** Resolve a config plugin spec to the package root Synergy should load from. */
export function resolveSpecPluginDir(spec: string): string {
  if (spec.startsWith("file://")) {
    const filePath = spec.slice("file://".length)
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

  for (const configPath of pluginPaths) {
    log.info("loading plugin", { path: configPath })
    const name = PluginSpec.displayName(configPath)
    const showInstallUI = !printedPluginPaths.has(configPath)

    let importPath: string
    let pluginDir: string

    if (!configPath.startsWith("file://")) {
      const { pkg, version } = PluginSpec.parse(configPath)

      if (showInstallUI) {
        StartupReporter.active()?.plugin({ name, status: "loaded" })
      }
      const result = await BunProc.install(pkg, version).catch((err) => {
        if (showInstallUI) {
          StartupReporter.active()?.plugin({ name, status: "failed", error: err.message ?? String(err) })
        }
        log.warn("plugin install failed, skipping", { name, error: err.message ?? err })
        return undefined
      })

      if (!result) continue
      if (showInstallUI) {
        StartupReporter.active()?.plugin({ name, status: result.cached ? "cached" : "installed" })
      }
      importPath = result.entryPath
      pluginDir = findPackageRoot(importPath)
    } else {
      const filePath = configPath.slice("file://".length)
      const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(ScopeContext.current.directory, filePath)
      importPath = absolute
      pluginDir = findPackageRoot(absolute)
    }

    if (showInstallUI) {
      printedPluginPaths.add(configPath)
    }

    const isLocal = configPath.startsWith("file://")
    const importUrl = isLocal ? `${importPath}?t=${reloadVersion}` : importPath
    const mod = await import(importUrl)

    const seen = new Set<PluginDescriptor>()

    for (const [, descriptor] of Object.entries<PluginDescriptor>(mod)) {
      if (!descriptor || typeof descriptor !== "object" || !descriptor.id || !descriptor.init) continue
      if (seen.has(descriptor)) continue
      seen.add(descriptor)

      const pluginId = descriptor.id
      const showLoadedUI = !printedPluginIds.has(pluginId)

      const input: PluginInput = {
        ...baseInput,
        pluginDir,
        config: createConfigAccessor(pluginId),
        auth: createAuthStore(pluginId),
        cache: createCacheStore(pluginId),
      }
      const hooks = await descriptor.init(input)
      loaded.push({
        id: pluginId,
        name: descriptor.name,
        hooks,
        pluginDir,
        cli: hooks.cli,
        skills: hooks.skills,
        agents: hooks.agents,
      })

      if (showLoadedUI) {
        printedPluginIds.add(pluginId)
        StartupReporter.active()?.plugin({ name: descriptor.name ?? pluginId, status: "loaded" })
      }
      log.info("loaded plugin", { id: pluginId, name: descriptor.name, pluginDir })
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

export async function getHooks(): Promise<Array<{ id: string; hooks: PluginHooks }>> {
  return state().then((x) => x.loaded.map((p) => ({ id: p.id, hooks: p.hooks })))
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
  const expectedDir = resolveSpecPluginDir(spec)
  return loaded.find((p) => p.pluginDir === expectedDir)
}
