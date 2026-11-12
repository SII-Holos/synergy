import type { Migration } from "../migration/types"
import { Storage } from "../storage/storage"
import { UpgradeWork } from "../storage/upgrade-work"
import { EnvironmentTransferRecords as Records } from "./transfer-records"

export const environmentTransferRecordMigration: Migration = {
  id: "20261112-environment-transfer-records",
  scope: "global",
  execution: "record",
  description: "Validate immutable Environment mapping evidence without allocating resources",
  async up() {},
  upgradeRecord(key, value) {
    if (key[0] !== Records.prefix[0]) return
    Records.parse(key, value)
  },
}

export const environmentTransferPhysicalMigration: Migration = {
  id: "20261112-environment-transfer-storage",
  scope: "global",
  execution: "startup",
  dependsOn: [environmentTransferRecordMigration.id],
  description: "Validate all retained Environment transfer evidence through its owning reader",
  async up(progress) {
    let count = 0
    for await (const row of Storage.records({ prefix: Records.prefix, limit: 64 })) {
      UpgradeWork.signal()?.throwIfAborted()
      await Storage.transaction(async () => {
        Records.parse(row.key, await Storage.read(row.key))
      })
      progress(++count, 0)
    }
    progress(count, count)
  },
}
