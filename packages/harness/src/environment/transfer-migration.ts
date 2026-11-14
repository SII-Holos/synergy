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

export const environmentTransferHistoryMigration: Migration = {
  ...environmentTransferPhysicalMigration,
  id: "20261112-environment-transfer-completed-history",
  dependsOn: [environmentTransferPhysicalMigration.id],
  description: "Validate retained descriptor and completed-history Environment reader versions",
}

export const environmentTransferMappingRecordMigration: Migration = {
  ...environmentTransferRecordMigration,
  id: "20261114-environment-transfer-logical-mapping-records",
  dependsOn: [environmentTransferRecordMigration.id],
  description: "Read explicit logical Environment mappings while preserving original immutable facts",
}

export const environmentTransferMappingPhysicalMigration: Migration = {
  ...environmentTransferPhysicalMigration,
  id: "20261114-environment-transfer-logical-mapping-storage",
  dependsOn: [environmentTransferMappingRecordMigration.id, environmentTransferHistoryMigration.id],
  description: "Validate explicit Environment mapping readers without allocating or rewriting historical facts",
}
