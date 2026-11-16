import type { Migration } from "../migration/types"
import { Storage } from "../storage/storage"
import { UpgradeWork } from "../storage/upgrade-work"
import { EnvironmentExecutionSchema } from "./execution-schema"

function validate(key: string[], value: unknown) {
  const record = EnvironmentExecutionSchema.upgrade(value)
  if (record.execution.scopeID !== key[1] || record.execution.id !== key[2])
    throw new Error("Environment execution source belongs to another canonical address")
  return record
}
export const executionSourceRecordMigration: Migration = {
  id: "20261113-environment-execution-source-record",
  description: "Validate retained remote execution bindings without granting dispatch authority",
  scope: "global",
  execution: "record",
  async up() {},
  upgradeRecord(key, value) {
    if (key.length !== 3 || key[0] !== "environment_execution") return
    const record = validate(key, value)
    for (const name of Object.keys(value)) delete value[name]
    Object.assign(value, record)
  },
}
export const executionSourcePhysicalMigration: Migration = {
  id: "20261113-environment-execution-source-storage",
  description: "Verify all original native and retained remote execution receipt versions",
  scope: "global",
  execution: "startup",
  dependsOn: [executionSourceRecordMigration.id, "20261112-environment-execution-origin-storage"],
  async up(progress) {
    let count = 0
    for await (const row of Storage.records({ prefix: ["environment_execution"], limit: 64 })) {
      UpgradeWork.signal()?.throwIfAborted()
      if (row.key.length !== 3) throw new Error("Environment execution source has an unknown canonical address")
      await Storage.transaction(async () => {
        validate(row.key, await Storage.read(row.key))
      })
      progress(++count, 0)
    }
    progress(count, count)
  },
}
