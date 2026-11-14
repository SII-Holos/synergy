import { z } from "zod"
import { Storage } from "../storage/storage"
import { MigrationRegistry } from "../migration/registry"
import type { Migration } from "../migration/types"
import type { Session } from "../session"
import { SessionCortexContract } from "../session/cortex-contract"

export namespace CortexTransferHolds {
  const Index = z.strictObject({ version: z.literal(1), taskID: z.string(), handoffID: z.string() })
  const key = (scopeID: string, rootID: string, sessionID: string) => [
    "cortex_transfer_holds",
    scopeID,
    rootID,
    sessionID,
  ]
  export async function index(session: Pick<Session.Info, "id" | "scope" | "cortex">) {
    const hold = session.cortex?.transfer
    if (!hold) return
    SessionCortexContract.TransferHold.parse(hold)
    await Storage.write(
      key(session.scope.id, hold.rootSessionID, session.id),
      Index.parse({ version: 1, taskID: session.cortex!.taskID, handoffID: hold.handoffID }),
    )
  }
  export async function remove(session: Pick<Session.Info, "id" | "scope" | "cortex">) {
    const hold = session.cortex?.transfer
    if (hold) await Storage.remove(key(session.scope.id, hold.rootSessionID, session.id))
  }
  export async function* list(scopeID: string, rootID: string) {
    for await (const row of Storage.records({ prefix: ["cortex_transfer_holds", scopeID, rootID], limit: 128 })) {
      if (row.key.length !== 4) throw new Error("Invalid Cortex transfer hold index")
      yield { sessionID: row.key[3], ...Index.parse(row.value) }
    }
  }
}

export const cortexTransferHoldMigration: Migration = {
  id: "20261111-cortex-transfer-holds-v1",
  scope: "derived",
  execution: "maintenance",
  emptyInput: [["sessions"]],
  description: "Index retained native Cortex transfer holds without reconstructing lost task controls",
  async up(progress) {
    let count = 0
    for await (const row of Storage.records<Record<string, unknown>>({ kind: "session", limit: 128 })) {
      const cortex = row.value.cortex
      if (!cortex || typeof cortex !== "object" || !("transfer" in cortex) || !cortex.transfer) continue
      await Storage.transaction(async () => {
        const [current] = await Storage.readMany<Session.Info>([row.key])
        if (current?.cortex?.transfer) await CortexTransferHolds.index(current)
      })
      progress(++count, 0)
    }
    progress(count, count)
  },
}
const migrations = [cortexTransferHoldMigration]
export function registerCortexTransferMigrations() {
  MigrationRegistry.register("cortex-transfer", migrations)
}
