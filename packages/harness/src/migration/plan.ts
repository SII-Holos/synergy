import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { MigrationRegistry } from "./registry"
import { orderMigrations } from "./order"
import type { Migration } from "./types"

const Ledger = z.record(z.string(), z.number().finite().nonnegative())

export namespace MigrationPlan {
  export function separable(migration: Migration) {
    if (migration.execution === "after-convergence" || migration.execution === "maintenance") return true
    if (migration.execution === "startup" || migration.scope === "global") return true
    return Boolean((migration.scope === "session" || migration.scope === "derived") && migration.upSession)
  }

  export function ordered(domains: Map<string, Migration[]>) {
    const entries = [...domains].flatMap(([owner, migrations]) =>
      migrations.map((migration) => ({ domain: migration.domain ?? owner, migration })),
    )
    const byKey = new Map<string, (typeof entries)[number]>()
    for (const entry of entries) {
      const key = `${entry.domain}/${entry.migration.id}`
      if (byKey.has(key)) throw new Error(`Duplicate migration ${key}`)
      if (entry.migration.execution === "session" && !entry.migration.upSession)
        throw new Error(`Session migration ${key} requires an owner callback`)
      byKey.set(key, entry)
    }
    const graph = [...byKey].map(([key, entry]) => ({
      ...entry.migration,
      id: key,
      dependsOn: entry.migration.dependsOn?.map((dependency) => {
        const target = dependency.includes("/") ? dependency : `${entry.domain}/${dependency}`
        if (!byKey.has(target)) throw new Error(`Migration ${key} has missing dependency ${target}`)
        const required = byKey.get(target)!.migration.execution
        if ((required === "after-convergence" || required === "maintenance") && entry.migration.execution !== required)
          throw new Error(`Migration ${key} requires deferred dependency ${target}`)
        return target
      }),
    }))
    return orderMigrations(graph).map((migration) => byKey.get(migration.id)!)
  }

  export async function legacyLogs(root: string) {
    const read = async (name: string) => {
      try {
        return Ledger.parse(JSON.parse(await fs.readFile(path.join(root, "data", "meta", "migration", name), "utf8")))
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {}
        throw error
      }
    }
    const old = await read("log.json")
    const aliases = MigrationRegistry.legacyTracking()
    const result = new Map<string, Record<string, number>>()
    for (const { domain, migration } of ordered(MigrationRegistry.list())) {
      if (!result.has(domain)) result.set(domain, {})
      if (migration.id in old) result.get(domain)![migration.id] = old[migration.id]
      for (const owner of aliases.filter((item) => item.targetDomain === domain)) {
        for (const [id, timestamp] of Object.entries(old)) {
          const renamed = owner.aliases[id] ?? owner.rename?.(id) ?? id
          if (renamed === migration.id) result.get(domain)![migration.id] = timestamp
        }
      }
    }
    for (const owner of aliases) {
      const values = await read(`log-${owner.sourceDomain}.json`)
      const current = result.get(owner.targetDomain) ?? {}
      for (const [id, timestamp] of Object.entries(values))
        current[owner.aliases[id] ?? owner.rename?.(id) ?? id] = timestamp
      result.set(owner.targetDomain, current)
    }
    for (const domain of result.keys())
      result.set(domain, { ...result.get(domain), ...(await read(`log-${domain}.json`)) })
    return result
  }
}
