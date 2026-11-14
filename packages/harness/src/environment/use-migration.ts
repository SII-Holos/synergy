import type { Migration } from "../migration/types"
import { Storage } from "../storage/storage"
import { UpgradeWork } from "../storage/upgrade-work"
import { EnvironmentSchema } from "./schema"

function upgrade(key: string[], value: unknown) {
  const record = EnvironmentSchema.upgradeUse(value)
  if (record.use.id !== key[2] || record.use.target.environmentID !== key[1])
    throw new Error("Environment Use migration found another canonical ownership address")
  return record
}

export const environmentUseRecordMigration: Migration = {
  id: "20261112-environment-use-owner-record",
  description: "Retain original Environment Uses without inventing native owners",
  scope: "global",
  execution: "record",
  async up() {},
  upgradeRecord(key, value) {
    if (key.length !== 3 || key[0] !== "environment_use") return
    const record = upgrade(key, value)
    for (const name of Object.keys(value)) delete value[name]
    Object.assign(value, record)
  },
}

export const environmentUsePhysicalMigration: Migration = {
  id: "20261112-environment-use-owner-storage",
  description: "Fence old Use readers while retaining historical ownership as unknown",
  scope: "global",
  execution: "startup",
  dependsOn: [environmentUseRecordMigration.id],
  async up(progress) {
    let count = 0
    for await (const row of Storage.records({ prefix: ["environment_use"], limit: 64 })) {
      UpgradeWork.signal()?.throwIfAborted()
      if (row.key.length !== 3) throw new Error("Environment Use migration found an unknown record address")
      await Storage.transaction(async () => {
        const value = await Storage.read(row.key)
        const record = upgrade(row.key, value)
        if (JSON.stringify(value) !== JSON.stringify(record)) await Storage.write(row.key, record)
      })
      progress(++count, 0)
    }
    progress(count, count)
  },
}
