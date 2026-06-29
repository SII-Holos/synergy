import type { PluginConfigAccessor, PluginAuthStore, PluginCacheStore } from "@ericsanchezok/synergy-plugin"
import path from "path"
import fs from "fs/promises"
import { Config } from "../config/config"
import { PluginPaths } from "./paths"

// ---------------------------------------------------------------------------
// Plugin config accessor — reads/writes pluginConfig.{id} in synergy.jsonc
// ---------------------------------------------------------------------------

export function createConfigAccessor(pluginId: string): PluginConfigAccessor {
  return {
    async get() {
      const config = await Config.current()
      return (config.pluginConfig?.[pluginId] as Record<string, any>) ?? {}
    },
    async set(values: Record<string, any>) {
      const config = await Config.current()
      const current = (config.pluginConfig?.[pluginId] as Record<string, any>) ?? {}
      const merged = { ...current, ...values }
      await Config.domainUpdate("plugins", { pluginConfig: { [pluginId]: merged } } as any)
    },
  }
}

// ---------------------------------------------------------------------------
// Plugin auth store
//
// WARNING: Credentials are stored as unencrypted JSON on disk at
// Synergy data directory plugin/{id}/auth.json. Protect your filesystem.
// Future versions will use system keychain encryption.
// ---------------------------------------------------------------------------

function resolveAuthPath(pluginId: string) {
  return PluginPaths.authFile(pluginId)
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

export function createAuthStore(pluginId: string): PluginAuthStore {
  // TODO(v3): Migrate to PluginSecretStore using OS keychain.
  // 1. On startup, detect old plaintext plugin auth.json
  // 2. Migrate credentials to system keychain
  // 3. Rename old file to auth.json.bak
  // 4. Expose secret backend via PluginStatus
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
// Plugin cache store — Synergy cache directory plugin/{id}/
// ---------------------------------------------------------------------------

function resolveCacheDir(pluginId: string) {
  return PluginPaths.cacheDir(pluginId)
}

function cachePath(pluginId: string, key: string) {
  return path.join(resolveCacheDir(pluginId), `${key}.json`)
}

interface CacheEntry {
  value: unknown
  expires?: number
}

export function createCacheStore(pluginId: string): PluginCacheStore {
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
