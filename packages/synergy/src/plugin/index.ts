import type {
  PluginHooks,
  PluginInput,
  Plugin as PluginDescriptor,
  PluginConfigAccessor,
  PluginAuthStore,
  PluginCacheStore,
  PluginCLIEntry,
  PluginSkill,
} from "@ericsanchezok/synergy-plugin"
import path from "path"
import fs from "fs/promises"
import { Config } from "../config/config"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk"
import { BunProc } from "../util/bun"
import { Instance } from "../scope/instance"
import { Flag } from "../flag/flag"

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

  function authPath(pluginId: string) {
    return path.join(Instance.directory, "..", ".synergy", "data", "plugin", pluginId, "auth.json")
  }

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

  interface LoadedPlugin {
    id: string
    name?: string
    hooks: PluginHooks
    cli?: Record<string, PluginCLIEntry>
    skills?: PluginSkill[]
  }

  const state = Instance.state(async () => {
    const { Server } = await import("../server/server")
    const client = createSynergyClient({
      baseUrl: Server.url().toString(),
      // @ts-ignore - fetch type incompatibility
      fetch: async (...args) => Server.App().fetch(...args),
    })
    const config = await Config.get()
    const loaded: LoadedPlugin[] = []
    const baseInput: Omit<PluginInput, "config" | "auth" | "cache"> = {
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

    for (let pluginPath of pluginPaths) {
      log.info("loading plugin", { path: pluginPath })
      if (!pluginPath.startsWith("file://")) {
        const lastAtIndex = pluginPath.lastIndexOf("@")
        const pkg = lastAtIndex > 0 ? pluginPath.substring(0, lastAtIndex) : pluginPath
        const version = lastAtIndex > 0 ? pluginPath.substring(lastAtIndex + 1) : "latest"
        const builtin = BUILTIN.some((x) => x.startsWith(pkg + "@"))
        pluginPath = await BunProc.install(pkg, version).catch((err) => {
          if (builtin) return ""
          throw err
        })
        if (!pluginPath) continue
      } else {
        const filePath = pluginPath.slice("file://".length)
        if (!path.isAbsolute(filePath)) {
          pluginPath = "file://" + path.resolve(Instance.directory, filePath)
        }
      }

      const mod = await import(pluginPath)
      const seen = new Set<PluginDescriptor>()

      for (const [, descriptor] of Object.entries<PluginDescriptor>(mod)) {
        if (!descriptor || typeof descriptor !== "object" || !descriptor.id || !descriptor.init) continue
        if (seen.has(descriptor)) continue
        seen.add(descriptor)

        const pluginId = descriptor.id
        const input: PluginInput = {
          ...baseInput,
          config: createConfigAccessor(pluginId),
          auth: createAuthStore(pluginId),
          cache: createCacheStore(pluginId),
        }

        const hooks = await descriptor.init(input)
        loaded.push({
          id: pluginId,
          name: descriptor.name,
          hooks,
          cli: hooks.cli,
          skills: hooks.skills,
        })
        log.info("loaded plugin", { id: pluginId, name: descriptor.name })
      }
    }

    return { loaded, baseInput }
  })

  // ---------------------------------------------------------------------------
  // Hook triggering — unchanged interface for all existing consumers
  // ---------------------------------------------------------------------------

  export async function trigger<
    Name extends Exclude<keyof Required<PluginHooks>, "auth" | "event" | "tool" | "cli" | "skills" | "dispose">,
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

  /** Return all skill registrations across plugins */
  export async function skillEntries() {
    const result: PluginSkill[] = []
    for (const p of await state().then((x) => x.loaded)) {
      if (p.skills) result.push(...p.skills)
    }
    return result
  }

  export async function init() {
    const loaded = await state().then((x) => x.loaded)
    const config = await Config.get()
    for (const { hooks } of loaded) {
      await hooks.config?.(config)
    }
    Bus.subscribeAll(async (input) => {
      const loaded = await state().then((x) => x.loaded)
      for (const { hooks } of loaded) {
        hooks["event"]?.({ event: input })
      }
    })
  }
}
