import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationRecoveryPublicationRecords as Records } from "./publication-records"
import { fail } from "../error"

export const recoveryPublicationHistoryMigration: Migration = {
  id: "20261116-organization-recovery-publication-history",
  description:
    "Validate versioned original public signing and Hosted publication history without inventing legacy keys",
  scope: "global",
  execution: "startup",
  async up(progress) {
    let count = 0
    await Storage.snapshot(async () => {
      for await (const row of Storage.records({ prefix: ["organization-recovery", "publication"], limit: 128 })) {
        if (row.key.length === 3) Records.validate(row.value, row.key[2]!)
        else if (row.key.length === 5 && row.key[3] === "hosted") {
          const receipt = Records.validate(await Storage.read(Records.key(row.key[2]!)), row.key[2]!)
          Records.validateHosted(row.value, receipt, row.key[4]!)
        } else fail("PROTOCOL_MISMATCH", "Historical recovery publication has an unknown owner key")
        count++
      }
    })
    progress(count, count)
  },
}
