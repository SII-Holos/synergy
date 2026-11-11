import { StorageMutationGuard } from "@ericsanchezok/synergy-harness/storage/mutation-guard"
import type { StoreTransaction } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { SessionTransferEpochs as Epochs } from "@ericsanchezok/synergy-harness/session/transfer"

async function check(tx: StoreTransaction, key: string[]) {
  if (key[0] === "lattice_legacy_archive" && key.length >= 3) return Epochs.assertOwnerMutation(key[2])
  if (key[0] !== "lattice") return
  if (key[1] === "current" && key.length === 4) return Epochs.assertOwnerMutation(key[3])
  if (!["runs", "events"].includes(key[1]) || key.length < 4) return
  const [row] = await tx.readMany([["lattice", "runs", key[2], key[3]]])
  if (row && typeof row === "object" && "sessionID" in row && typeof row.sessionID === "string")
    await Epochs.assertOwnerMutation(row.sessionID)
}
export function registerLatticeTransferGuard() {
  StorageMutationGuard.register("lattice-transfer", async (tx, keys) => {
    for (const key of keys) {
      if ((key[0] === "lattice" && key.length >= 4) || (key[0] === "lattice_legacy_archive" && key.length >= 3)) {
        await check(tx, key)
        continue
      }
      if (key.length && !["lattice", "lattice_legacy_archive"].includes(key[0])) continue
      let after: string[] | undefined
      for (;;) {
        const rows = await tx.query({ prefix: key, after, limit: 128 })
        for (const row of rows) await check(tx, row.key)
        if (rows.length < 128) break
        after = rows.at(-1)!.key
      }
    }
  })
}
