import type {
  PluginHooks,
  PluginInput,
  Plugin as PluginDescriptor,
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
import { Instance } from "../scope/instance"
import { Flag } from "../flag/flag"
import { UI } from "../cli/ui"
import { Global } from "../global"
import { createConfigAccessor, createAuthStore, createCacheStore } from "./store"

const log = Log.create({ service: "plugin.loader" })
const BUILTIN: string[] = []
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
    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(Instance.directory, filePath)
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
  baseInput: Omit<PluginInput, "config" | "auth" | "cache" | "pluginDir">
}

export const state = Instance.state(async (): Promise<LoaderState> => {
  const { Server } = await import("../server/server")
  const client = createSynergyClient({
    baseUrl: Server.url().toString(),
    // @ts-ignore - fetch type incompatibility
    fetch: async (...args) => Server.App().fetch(...args),
  })
  const config = await Config.get()
  const loaded: LoadedPlugin[] = []
  const baseInput: Omit<PluginInput, "config" | "auth" | "cache" | "pluginDir"> = {
    client,
    scope: Instance.scope,
    worktree: Instance.worktree,
    directory: Instance.directory,
    serverUrl: Server.url(),
    $: Bun.$,
  }

  const pluginPaths = [...(config.plugin ?? [])]
  if (!Flag.SYNERGY_DISABLE_DEFAULT_PLUGINS) {
    pluginPaths.push(...BUILTIN)
  }

  let installedCount = 0
  let failedCount = 0

  for (const configPath of pluginPaths) {
    log.info("loading plugin", { path: configPath })
    const name = PluginSpec.displayName(configPath)
    const showInstallUI = !printedPluginPaths.has(configPath)

    let importPath: string
    let pluginDir: string

    if (!configPath.startsWith("file://")) {
      const { pkg, version } = PluginSpec.parse(configPath)

      if (showInstallUI) {
        UI.println(`  Loading plugin: ${name}${UI.Style.TEXT_DIM}...${UI.Style.TEXT_NORMAL}`)
      }
      const result = await BunProc.install(pkg, version).catch((err) => {
        if (showInstallUI) {
          UI.println(`  ${UI.Style.TEXT_DANGER}✘${UI.Style.TEXT_NORMAL} ${name} failed: ${err.message ?? err}`)
        }
        log.warn("plugin install failed, skipping", { name, error: err.message ?? err })
        failedCount++
        return undefined
      })

      if (!result) continue
      if (showInstallUI) {
        installedCount++
        UI.println(
          result.cached
            ? `  ${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} ${name} ${UI.Style.TEXT_DIM}(cached)${UI.Style.TEXT_NORMAL}`
            : `  ${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} ${name} installed`,
        )
      }
      importPath = result.entryPath
      pluginDir = findPackageRoot(importPath)
    } else {
      const filePath = configPath.slice("file://".length)
      const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(Instance.directory, filePath)
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
        UI.println(`  ${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} ${descriptor.name ?? pluginId} loaded`)
      }
      log.info("loaded plugin", { id: pluginId, name: descriptor.name, pluginDir })
    }
  }

  if (installedCount > 0 || failedCount > 0) {
    const parts: string[] = []
    if (installedCount > 0) parts.push(`${installedCount} installed`)
    if (failedCount > 0) parts.push(`${failedCount} failed`)
    UI.println(`  Plugins: ${parts.join(", ")}`)
  }

  return { loaded, baseInput }
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
