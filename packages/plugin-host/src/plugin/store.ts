import path from "path"
import fs from "fs/promises"
import { PluginPaths } from "./paths"

export interface PluginSecretStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  has(key: string): Promise<boolean>
}

async function read(pluginId: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await Bun.file(PluginPaths.authFile(pluginId)).text())
  } catch {
    return {}
  }
}

async function write(pluginId: string, values: Record<string, string>) {
  const file = PluginPaths.authFile(pluginId)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await Bun.write(file, JSON.stringify(values, null, 2))
}

export function createAuthStore(pluginId: string): PluginSecretStore {
  return {
    async get(key) {
      return (await read(pluginId))[key]
    },
    async set(key, value) {
      const values = await read(pluginId)
      values[key] = value
      await write(pluginId, values)
    },
    async delete(key) {
      const values = await read(pluginId)
      delete values[key]
      await write(pluginId, values)
    },
    async has(key) {
      return key in (await read(pluginId))
    },
  }
}
