import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationRecoveryPublicationRecords as Records } from "./publication-records"
import { fail } from "../error"
import { OrganizationQueuedSnapshotProtocol as Queued } from "@ericsanchezok/synergy-organization-protocol"

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
          const mapping = Records.validateHosted(row.value, receipt, row.key[4]!)
          const items: Queued.Item[] = []
          for await (const item of Storage.records({
            prefix: [...Records.hostedKey(row.key[2]!, row.key[4]!), "queued"],
            limit: 128,
          })) {
            const selected = Queued.Item.parse(item.value)
            if (
              JSON.stringify(item.key) !== JSON.stringify(Records.queuedKey(row.key[2]!, row.key[4]!, selected.grantID))
            )
              fail("PROTOCOL_MISMATCH", "Queued publication has another original metadata key")
            items.push(selected)
          }
          await Records.validateQueuedItems(mapping, items)
        } else if (row.key.length === 7 && row.key[3] === "hosted" && row.key[5] === "queued") {
          const item = Queued.Item.parse(row.value)
          if (item.grantID !== row.key[6]) fail("PROTOCOL_MISMATCH", "Queued publication has another original grant")
          const receipt = Records.validate(await Storage.read(Records.key(row.key[2]!)), row.key[2]!)
          if (
            !Records.validateHosted(
              await Storage.read(Records.hostedKey(row.key[2]!, row.key[4]!)),
              receipt,
              row.key[4]!,
            ).queued
          )
            fail("PROTOCOL_MISMATCH", "Queued publication lacks its original mapping")
        } else fail("PROTOCOL_MISMATCH", "Historical recovery publication has an unknown owner key")
        count++
      }
    })
    progress(count, count)
  },
}
