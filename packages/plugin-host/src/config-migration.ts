import path from "node:path"
import { mergeDeep } from "remeda"
import { AtomicFile } from "@ericsanchezok/synergy-util/atomic-file"
import { ConfigReferenceMigration } from "@ericsanchezok/synergy-harness/config/reference-migration"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Global } from "@ericsanchezok/synergy-harness/global"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function upgradeConfig(config: Record<string, unknown>) {
  if (!record(config.sii)) return
  if (config.pluginConfig !== undefined && !record(config.pluginConfig)) return
  const plugins = config.pluginConfig ?? {}
  if (plugins.inspire !== undefined && !record(plugins.inspire)) return
  config.pluginConfig = { ...plugins, inspire: mergeDeep(config.sii, plugins.inspire ?? {}) }
  delete config.sii
}

async function read(file: string): Promise<unknown> {
  try {
    return await Bun.file(file).json()
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

async function credentials(root: string) {
  const target = path.join(Global.Path.data, "plugin", "inspire", "auth.json")
  if (await Bun.file(target).exists()) return
  const result: Record<string, string> = {}
  for (const service of ["inspire", "harbor"]) {
    const legacy = await read(path.join(root, "data", "auth", `${service}.json`))
    if (!record(legacy)) continue
    for (const key of ["username", "password"])
      if (typeof legacy[key] === "string") result[`${service}-${key}`] = legacy[key]
  }
  if (Object.keys(result).length)
    await AtomicFile.writeFileAtomic(target, JSON.stringify(result), { private: true, durable: true })
}

async function cache(root: string) {
  for (const [legacy, key] of [
    ["inspire-token", "inspire-token"],
    ["inspire-resources", "resources"],
  ]) {
    const target = path.join(Global.Path.cache, "plugin", "inspire", `${key}.json`)
    if (await Bun.file(target).exists()) continue
    const value = await read(path.join(root, "cache", `${legacy}.json`))
    if (value !== undefined)
      await AtomicFile.writeFileAtomic(target, JSON.stringify({ value }), { private: true, durable: true })
  }
}

export const configMigrations: Migration[] = [
  {
    id: "20261012-plugin-config-owner",
    description: "Restore retained plugin configuration when Plugin Host is installed",
    configuration: "files",
    scope: "global",
    execution: "startup",
    upgradeConfig,
    up: (progress) => ConfigReferenceMigration.up(progress, { relocateKeys: ["pluginConfig"] }),
  },
  {
    id: "20261012-plugin-legacy-stores-owner",
    description: "Restore legacy plugin credentials and cache after catalog upgrades",
    scope: "global",
    execution: "startup",
    dependsOn: [
      "plugin_catalog/20260712-plugin-api-3-catalog",
      "plugin_catalog/20260801-plugin-api-4-stable-approvals",
      "plugin_catalog/20260914-plugin-transactional-records",
    ],
    async up(progress) {
      progress(0, 2)
      const host = RuntimeContext.current().host
      const root = path.join(host.env.HOME ?? host.env.USERPROFILE ?? host.home, ".synergy")
      await credentials(root)
      progress(1, 2)
      await cache(root)
      progress(2, 2)
    },
  },
]
