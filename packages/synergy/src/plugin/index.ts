import type {
  PluginHooks,
  PluginInput,
  Plugin as PluginDescriptor,
  PluginConfigAccessor,
  PluginAuthStore,
  PluginCacheStore,
  PluginCLIEntry,
  PluginSkill,
  PluginAgent,
} from "@ericsanchezok/synergy-plugin"
import path from "path"
import fs from "fs/promises"
import { existsSync } from "fs"
import { Config } from "../config/config"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import { BunProc } from "../util/bun"
import { PluginSpec } from "../util/plugin-spec"
import { Instance } from "../scope/instance"
import { Flag } from "../flag/flag"
import { UI } from "../cli/ui"
import z from "zod"
import { PluginManifest } from "@ericsanchezok/synergy-plugin"
import { Installation } from "../global/installation"
import { Global } from "../global"
import { startForPlugin, stopForPlugin } from "./mcp"
import * as Lockfile from "./lockfile"
import * as ManifestReader from "./manifest-reader"

export namespace Plugin {
  const log = Log.create({ service: "plugin" })
  const BUILTIN: string[] = []

  // ---------------------------------------------------------------------------
  // Plugin config accessor — reads/writes pluginConfig.{id} in synergy.jsonc
  // ---------------------------------------------------------------------------

  function createConfigAccessor(pluginId: string): PluginConfigAccessor {
    return {
      async get() {
        const config = await Config.get()
        return (config.pluginConfig?.[pluginId] as Record<string, any>) ?? {}
      },
      async set(values: Record<string, any>) {
        const config = await Config.get()
        const current = (config.pluginConfig?.[pluginId] as Record<string, any>) ?? {}
        const merged = { ...current, ...values }
        await Config.updateGlobal({ pluginConfig: { [pluginId]: merged } } as any)
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Plugin auth store — encrypted credentials at ~/.synergy/data/plugin/{id}/auth.json
  // ---------------------------------------------------------------------------

  function resolveAuthPath(pluginId: string) {
    const home = process.env.HOME || process.env.USERPROFILE || "~"
    return path.join(home, ".synergy", "data", "plugin", pluginId, "auth.json")
  }

  async function readAuthFile(pluginId: string): Promise<Record<string, string>> {
    const p = resolveAuthPath(pluginId)
    try {
      const text = await Bun.file(p).text()
      return JSON.parse(text)
    } catch {
      return {}
    }
  }

  async function writeAuthFile(pluginId: string, data: Record<string, string>) {
    const p = resolveAuthPath(pluginId)
    await fs.mkdir(path.dirname(p), { recursive: true })
    await Bun.write(p, JSON.stringify(data, null, 2))
  }

  function createAuthStore(pluginId: string): PluginAuthStore {
    return {
      async get(key) {
        const data = await readAuthFile(pluginId)
        return data[key]
      },
      async set(key, value) {
        const data = await readAuthFile(pluginId)
        data[key] = value
        await writeAuthFile(pluginId, data)
      },
      async delete(key) {
        const data = await readAuthFile(pluginId)
        delete data[key]
        await writeAuthFile(pluginId, data)
      },
      async has(key) {
        const data = await readAuthFile(pluginId)
        return key in data
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Plugin cache store — ~/.synergy/cache/plugin/{id}/
  // ---------------------------------------------------------------------------

  function resolveCacheDir(pluginId: string) {
    const home = process.env.HOME || process.env.USERPROFILE || "~"
    return path.join(home, ".synergy", "cache", "plugin", pluginId)
  }

  function cachePath(pluginId: string, key: string) {
    return path.join(resolveCacheDir(pluginId), `${key}.json`)
  }

  interface CacheEntry {
    value: unknown
    expires?: number
  }

  function createCacheStore(pluginId: string): PluginCacheStore {
    return {
      directory: resolveCacheDir(pluginId),
      async get<T = unknown>(key: string): Promise<T | undefined> {
        try {
          const text = await Bun.file(cachePath(pluginId, key)).text()
          const entry: CacheEntry = JSON.parse(text)
          if (entry.expires && Date.now() > entry.expires) {
            await fs.unlink(cachePath(pluginId, key)).catch(() => {})
            return undefined
          }
          return entry.value as T
        } catch {
          return undefined
        }
      },
      async set(key: string, value: unknown, ttl?: number) {
        const p = cachePath(pluginId, key)
        await fs.mkdir(path.dirname(p), { recursive: true })
        const entry: CacheEntry = { value }
        if (ttl) entry.expires = Date.now() + ttl
        await Bun.write(p, JSON.stringify(entry))
      },
      async delete(key: string) {
        await fs.unlink(cachePath(pluginId, key)).catch(() => {})
      },
    }
  }

  // ---------------------------------------------------------------------------
  // Loaded plugin state
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
  function findPackageRoot(entryPath: string): string {
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
  function resolveSpecPluginDir(spec: string): string {
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

  const state = Instance.state(async () => {
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

      const mod = await import(importPath)
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
    for (const { hooks } of await state().then((x) => x.loaded)) {
      const fn = hooks[name]
      if (!fn) continue
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

  /** Return all loaded plugin hooks (for tool/auth/event consumers) */
  export async function list() {
    return state().then((x) => x.loaded.map((p) => p.hooks))
  }

  /** Return loaded plugin metadata */
  export async function descriptors() {
    return state().then((x) => x.loaded.map((p) => ({ id: p.id, name: p.name })))
  }

  /** Return all CLI registrations across plugins */
  export async function cliEntries() {
    const result: Array<{ pluginId: string; commands: Record<string, PluginCLIEntry> }> = []
    for (const p of await state().then((x) => x.loaded)) {
      if (p.cli && Object.keys(p.cli).length > 0) {
        result.push({ pluginId: p.id, commands: p.cli })
      }
    }
    return result
  }

  /** Return all skill registrations across plugins (with pluginDir for filesystem resolution) */
  export async function skillEntries() {
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

  /** Return all agent registrations across plugins */
  export async function agentEntries() {
    const result: Record<string, PluginAgent> = {}
    for (const p of await state().then((x) => x.loaded)) {
      if (p.agents) Object.assign(result, p.agents)
    }
    return result
  }

  export async function init() {
    const loaded = await state().then((x) => x.loaded)
    const config = await Config.get()
    for (const { id, hooks } of loaded) {
      await hooks.config?.(config)
      const m = await manifest(id)
      if (m?.contributes?.mcp) {
        // Plugin-contributed MCP servers may spawn network-backed `npx` processes.
        // Start them in the background so server readiness, channel bootstrap, and the UI banner are not blocked.
        void startForPlugin(id, m.contributes.mcp).catch((err) => log.error("plugin mcp start error", { id, err }))
      }
    }
    Bus.subscribeAll(async (input) => {
      const loaded = await state().then((x) => x.loaded)
      for (const { hooks } of loaded) {
        hooks["event"]?.({ event: input })
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Lifecycle management — add, remove, get, manifest
  // ---------------------------------------------------------------------------

  /** Map specs like "github:SII-Holos/holos-inspire" to their loaded plugin IDs. */
  const specToPluginId = new Map<string, string>()

  export async function add(spec: string, opts: { autoReload?: boolean } = {}): Promise<LoadedPlugin> {
    const { pkg, version } = PluginSpec.parse(spec)

    // Explicit installs should refresh cached registry/git packages.
    await BunProc.invalidateCache(pkg)

    // Install the plugin package
    const result = await BunProc.install(pkg, version)

    // Read and validate plugin.json manifest if it exists
    const pluginDir = findPackageRoot(result.entryPath)
    const pluginJsonPath = path.join(pluginDir, "plugin.json")
    let manifestData: z.infer<typeof PluginManifest> | null = null
    try {
      const raw = await Bun.file(pluginJsonPath).text()
      const parsed = JSON.parse(raw)
      manifestData = PluginManifest.parse(parsed)
      log.info("plugin manifest loaded", { path: spec, manifest: manifestData })
    } catch (err) {
      log.warn("no valid plugin.json found, skipping manifest check", { path: spec, err: String(err) })
    }

    // Check minSynergyVersion compatibility
    if (manifestData?.minSynergyVersion && Installation.VERSION !== "local") {
      const currentVersion = Installation.VERSION
      if (!satisfiesMinVersion(currentVersion, manifestData.minSynergyVersion)) {
        throw new Error(
          `Plugin ${spec} requires Synergy >= ${manifestData.minSynergyVersion}, but current version is ${currentVersion}`,
        )
      }
    }

    // Log declared dependencies (Phase 3 will auto-install)
    if (manifestData?.dependencies && Object.keys(manifestData.dependencies).length > 0) {
      log.info("plugin declares dependencies (not auto-installed yet)", {
        plugin: spec,
        dependencies: manifestData.dependencies,
      })
    }

    // Update lockfile with installed plugin entry
    const lockfile = await Lockfile.read()
    const updatedLockfile = Lockfile.addEntry(lockfile, pkg, {
      spec,
      version,
      resolved: result.entryPath,
    })
    await Lockfile.write(updatedLockfile)

    // Add to config.plugin[] array
    const config = await Config.get()
    const currentPlugins = config.plugin ?? []
    if (!currentPlugins.includes(spec)) {
      await Config.updateGlobal({ plugin: [...currentPlugins, spec] } as any)
      await Config.reload("global")
    }

    // Reload plugins to load the new one
    if (opts.autoReload !== false) {
      await reload()
    }

    // Find the newly loaded plugin
    const { loaded } = await state()
    const plugin = loaded.find((p) => {
      // Match by checking if any plugin in the same pluginDir has a matching spec
      // For non-registry specs, match by the actual entry path
      return p.pluginDir === findPackageRoot(result.entryPath)
    })

    if (!plugin) {
      throw new Error(`Plugin was installed but failed to load: ${spec}`)
    }

    specToPluginId.set(spec, plugin.id)
    return plugin
  }

  export async function remove(pluginId: string, opts: { autoReload?: boolean } = {}): Promise<void> {
    const current = await state().catch(() => null)
    const plugin = current?.loaded.find((p) => p.id === pluginId)
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`)
    }

    // Dispose the plugin
    if (plugin.hooks.dispose) {
      await plugin.hooks.dispose().catch((err) => {
        log.error("plugin dispose error during remove", { id: pluginId, err })
      })
    }

    // Remove from config.plugin[] array
    const config = await Config.get()
    const currentPlugins = config.plugin ?? []
    let configChanged = false
    const kept = currentPlugins.filter((spec) => {
      const entry = specToPluginId.get(spec)
      if (entry != null) return entry !== pluginId
      return resolveSpecPluginDir(spec) !== plugin.pluginDir
    })

    if (kept.length < currentPlugins.length) {
      await Config.updateGlobal({ plugin: kept } as any)
      configChanged = true
    }

    // Remove pluginConfig.{pluginId}
    if (config.pluginConfig?.[pluginId]) {
      const { [pluginId]: _, ...rest } = config.pluginConfig ?? {}
      await Config.updateGlobal({ pluginConfig: rest } as any)
      configChanged = true
    }

    if (configChanged) {
      await Config.reload("global")
    }

    // Clear the spec → pluginId mapping and remove from lockfile
    let lockfile = await Lockfile.read()
    for (const [key, value] of specToPluginId) {
      if (value === pluginId) {
        lockfile = Lockfile.removeEntry(lockfile, PluginSpec.parse(key).pkg)
        specToPluginId.delete(key)
      }
    }
    await Lockfile.write(lockfile)

    if (opts.autoReload !== false) {
      await reload()
    }
  }

  export async function get(pluginId: string): Promise<LoadedPlugin | undefined> {
    return state().then((x) => x.loaded.find((p) => p.id === pluginId))
  }

  export async function manifest(pluginId: string): Promise<z.infer<typeof PluginManifest> | null> {
    const plugin = await get(pluginId)
    if (!plugin) return null
    return ManifestReader.read(plugin.pluginDir)
  }

  /** Return all currently loaded plugins (metadata + hooks). */
  export async function loaded(): Promise<LoadedPlugin[]> {
    return state().then((x) => x.loaded)
  }

  /** Look up a config spec string to the matching loaded plugin (if any). */
  export async function lookupSpec(spec: string): Promise<LoadedPlugin | undefined> {
    const pluginId = specToPluginId.get(spec)
    if (pluginId) return get(pluginId)

    const { loaded: loadedPlugins } = await state()
    const expectedDir = resolveSpecPluginDir(spec)
    return loadedPlugins.find((p) => p.pluginDir === expectedDir)
  }

  // ---------------------------------------------------------------------------
  // Semver helper — lightweight comparison for minSynergyVersion checks
  // ---------------------------------------------------------------------------

  function satisfiesMinVersion(current: string, required: string): boolean {
    const [cm, cn, cp] = current.split(".").map(Number)
    const [rm, rn, rp] = required.split(".").map(Number)
    if (isNaN(cm) || isNaN(rm)) return false
    if (cm !== rm) return cm >= rm
    if (cn !== rn) return cn >= rn
    return cp >= rp
  }
}
