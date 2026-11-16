import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { OrganizationExecutionProtocol as Execution } from "@ericsanchezok/synergy-organization-protocol"

export const executionHandoffMigration: Migration = {
  id: "20261112-organization-execution-handoff-closure",
  description: "Fence native grants with distinct handoff closure evidence",
  scope: "global",
  execution: "record",
  dependsOn: ["20261109-organization-execution-retention-generations"],
  async up() {},
  upgradeRecord(key, record) {
    if (key.length !== 3 || key[0] !== "organization" || key[1] !== "execution-grants" || record.schemaVersion !== 3)
      return
    Execution.LegacyGrant3.parse(record)
    record.schemaVersion = 4
    Execution.LegacyGrant4.parse(record)
  },
}
