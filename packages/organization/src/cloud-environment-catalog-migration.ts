import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { UpgradeWork } from "@ericsanchezok/synergy-harness/storage/upgrade-work"
import { OrganizationCloudRecord as Record } from "./cloud-records"
import { fail } from "./error"

export const cloudEnvironmentCatalogMigration: Migration = {
  id: "20261114-organization-cloud-environment-catalog",
  description: "Index canonical Environment identities by their original project and resource",
  scope: "global",
  execution: "startup",
  async up(progress) {
    let count = 0
    for await (const row of Storage.records({ prefix: ["organization", "cloud", "environments"], limit: 128 })) {
      UpgradeWork.signal()?.throwIfAborted()
      const locator = Record.Locator.parse(row.value)
      if (JSON.stringify(row.key) !== JSON.stringify(Record.key("environments", locator.id)))
        fail("PROTOCOL_MISMATCH", "Environment catalog has another canonical key")
      await Storage.transaction(() =>
        Storage.write(
          [...Record.projectKey("environments", locator.orgID, locator.projectID, locator.resourceID), locator.id],
          { id: locator.id },
        ),
      )
      progress(++count, 0)
    }
    progress(count, count)
  },
}
