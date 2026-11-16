import { z } from "zod"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import {
  OrganizationExecutionProtocol as Execution,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"

const grantIDs = z
  .array(Identity.ID)
  .refine((ids) => new Set(ids).size === ids.length, "Retained grant identities must be unique")
const limits = Execution.Limits.extend({ calls: z.number().int().positive().max(4096) })

export const executionMigration: Migration = {
  id: "20261109-organization-execution-without-product-quotas",
  description: "Retain execution ownership without inline grant arrays or an additional task-call quota",
  scope: "global",
  execution: "record",
  async up() {},
  upgradeRecord(key, record) {
    if (key.length !== 3 || key[0] !== "organization" || record.schemaVersion !== 1) return
    if (key[1] === "sessions") {
      record.retainedExecutionGrants = grantIDs.parse(record.executionGrantIDs).length
      delete record.executionGrantIDs
      record.schemaVersion = 2
    }
    if (key[1] === "execution-grants") {
      const { calls: _, ...perCall } = limits.parse(record.limits)
      record.limits = perCall
      record.schemaVersion = 2
    }
  },
}
