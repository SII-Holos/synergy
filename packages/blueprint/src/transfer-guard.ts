import { StorageMutationGuard } from "@ericsanchezok/synergy-harness/storage/mutation-guard"
import { SessionTransferEpochs as Epochs } from "@ericsanchezok/synergy-harness/session/transfer"
import type { StoreTransaction } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { BlueprintTransferIndex } from "./transfer-index"
import type { Info as Loop } from "./blueprint/types"
import type { SuperPlanTypes } from "./superplan/types"

async function check(tx: StoreTransaction, path: string[]) {
  const [record] = await tx.readMany([path])
  if (!record || typeof record !== "object") return
  const sessions =
    path[0] === "blueprint_loops"
      ? BlueprintTransferIndex.loopSessions(record as Loop)
      : BlueprintTransferIndex.planSessions(record as SuperPlanTypes.Run)
  for (const sessionID of sessions) await Epochs.assertOwnerMutation(sessionID)
}

export function registerBlueprintTransferGuard() {
  StorageMutationGuard.register("blueprint-transfer", async (tx, keys) => {
    for (const path of keys) {
      if (path[0] === "blueprint_loops" && path.length >= 3) await check(tx, path.slice(0, 3))
      else if (path[0] === "superplan" && ["runs", "events"].includes(path[1]) && path.length >= 4)
        await check(tx, ["superplan", "runs", path[2], path[3]])
      else {
        for (const prefix of [["blueprint_loops"], ["superplan", "runs"]]) {
          if (
            path.some((part, index) => prefix[index] !== undefined && part !== prefix[index]) ||
            path.length >= (prefix[0] === "blueprint_loops" ? 3 : 4)
          )
            continue
          let after: string[] | undefined
          for (;;) {
            const rows = await tx.query({ prefix: path.length < prefix.length ? prefix : path, after, limit: 128 })
            for (const row of rows)
              if (row.key.length === (prefix[0] === "blueprint_loops" ? 3 : 4)) await check(tx, row.key)
            if (rows.length < 128) break
            after = rows.at(-1)!.key
          }
        }
      }
    }
  })
}
