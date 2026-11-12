import { z } from "zod"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { OrganizationExecutionProtocol as Execution } from "@ericsanchezok/synergy-organization-protocol"

export const executionRetentionMigration: Migration = {
  id: "20261109-organization-execution-retention-generations",
  description: "Track retained root resources and the generation of each reserved gateway call",
  scope: "global",
  execution: "record",
  dependsOn: ["20261109-organization-execution-without-product-quotas"],
  async up() {},
  upgradeRecord(key, record) {
    if (key[0] !== "organization") return
    if (key.length === 3 && key[1] === "execution-grants" && record.schemaVersion === 2) {
      z.undefined().parse(record.retention)
      record.schemaVersion = 3
      if (record.state === "bound") record.retention = { state: "held", generation: 1 }
      Execution.LegacyGrant3.parse(record)
    }
    if (key.length === 4 && key[1] === "gateway-calls" && record.schemaVersion === 1) {
      z.undefined().parse(record.retentionGeneration)
      record.schemaVersion = 2
      record.retentionGeneration = 1
    }
  },
}
