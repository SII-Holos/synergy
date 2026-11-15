import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { OrganizationExecutionProtocol as Execution } from "@ericsanchezok/synergy-organization-protocol"

export const executionRecoveryMigration: Migration = {
  id: "20261116-organization-execution-restoration-provenance",
  description: "Retain original accepted attribution while versioning explicit restoration continuations",
  scope: "global",
  execution: "record",
  dependsOn: ["20261112-organization-execution-infrastructure-selection"],
  async up() {},
  upgradeRecord(key, record) {
    if (key.length !== 3 || key[0] !== "organization" || key[1] !== "execution-grants" || record.schemaVersion !== 5)
      return
    Execution.LegacyGrant5.parse(record)
    record.schemaVersion = 6
    Execution.Grant.parse(record)
  },
}
