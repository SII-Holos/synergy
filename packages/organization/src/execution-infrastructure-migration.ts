import { z } from "zod"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import {
  OrganizationExecutionProtocol as Execution,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"

const legacyContract = z.strictObject({
  schemaVersion: z.literal(1),
  orgID: Identity.ID,
  sessionID: Identity.ID,
  revision: Identity.Revision.refine((value) => value > 0),
  selection: Execution.LegacySelection,
})

export const executionInfrastructureMigration: Migration = {
  id: "20261112-organization-execution-infrastructure-selection",
  description: "Make native and organization infrastructure selection explicit without changing accepted execution",
  scope: "global",
  execution: "record",
  dependsOn: ["20261112-organization-execution-handoff-closure"],
  async up() {},
  upgradeRecord(key, record) {
    if (key.length !== 3 || key[0] !== "organization") return
    if (key[1] === "session-resources" && record.schemaVersion === 1) {
      const previous = legacyContract.parse(record)
      record.schemaVersion = 2
      record.selection = { ...previous.selection, infrastructure: { workspace: null, environment: null } }
    }
    if (key[1] === "execution-grants" && record.schemaVersion === 4) {
      const previous = Execution.LegacyGrant4.parse(record)
      record.schemaVersion = 5
      record.selection = { ...previous.selection, infrastructure: { workspace: null, environment: null } }
      Execution.Grant.parse(record)
    }
  },
}
