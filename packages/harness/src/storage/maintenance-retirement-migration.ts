import type { Migration } from "../migration/types"
import { Storage } from "./storage"
import { UpgradeWork } from "./upgrade-work"
import { MaintenanceRetirementRecords as Records } from "./maintenance-retirement-records"

export const maintenanceRetirementRecordMigration: Migration = {
  id: "20261112-maintenance-retirement-records",
  scope: "global",
  execution: "record",
  description: "Validate immutable native source-retirement reservations",
  async up() {},
  upgradeRecord(key, value) {
    if (key[0] !== Records.prefix[0] || key[1] !== Records.prefix[1]) return
    Records.parse(key, value)
  },
}

export const maintenanceRetirementPhysicalMigration: Migration = {
  id: "20261112-maintenance-retirement-storage",
  scope: "global",
  execution: "startup",
  dependsOn: [maintenanceRetirementRecordMigration.id],
  description: "Validate retained source-retirement evidence through its native owner",
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
