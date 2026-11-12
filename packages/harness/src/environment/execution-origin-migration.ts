import type { Migration } from "../migration/types"
import { Storage } from "../storage/storage"
import { UpgradeWork } from "../storage/upgrade-work"
import { EnvironmentExecutionSchema } from "./execution-schema"
import { EnvironmentExecutionOriginIndex } from "./execution-origin-index"

function upgrade(key: string[], value: unknown) {
  const record = EnvironmentExecutionSchema.upgrade(value)
  if (record.execution.scopeID !== key[1] || record.execution.id !== key[2])
    throw new Error("Environment execution record belongs to another canonical key")
  return record
}

export const executionOriginRecordMigration: Migration = {
  id: "20261112-environment-execution-origin-record",
  description: "Read legacy execution receipts without inventing a Session origin",
  scope: "global",
  execution: "record",
  async up() {},
  upgradeRecord(key, value) {
    if (key.length !== 3 || key[0] !== "environment_execution") return
    const record = upgrade(key, value)
    for (const name of Object.keys(value)) delete value[name]
    Object.assign(value, record)
  },
}

export const executionOriginPhysicalMigration: Migration = {
  id: "20261112-environment-execution-origin-storage",
  description: "Fence old execution readers with an explicit stored receipt envelope",
  scope: "global",
  execution: "startup",
  dependsOn: ["20261112-environment-execution-origin-record", "20260928-environment-active-executions"],
  async up(progress) {
    await Storage.transaction(() => EnvironmentExecutionOriginIndex.reset())
    let count = 0
    for await (const row of Storage.records({ prefix: ["environment_execution"], limit: 64 })) {
      UpgradeWork.signal()?.throwIfAborted()
      if (row.key.length !== 3) throw new Error("Environment execution migration found an unknown record address")
      await Storage.transaction(async () => {
        const value = await Storage.read(row.key)
        const record = upgrade(row.key, value)
        if (JSON.stringify(value) !== JSON.stringify(record)) await Storage.write(row.key, record)
        await EnvironmentExecutionOriginIndex.update(record.execution)
      })
      progress(++count, 0)
    }
    await Storage.transaction(() => EnvironmentExecutionOriginIndex.sealCoverage())
    progress(count, count)
  },
}
