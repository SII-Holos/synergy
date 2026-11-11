import { z } from "zod"
import { Storage } from "../storage/storage"
import { MigrationRegistry } from "../migration/registry"
import type { Migration } from "../migration/types"
import type { Session } from "../session"
import { SessionCortexContract } from "../session/cortex-contract"

export namespace CortexMaintenanceHolds {
  const Index = z.strictObject({ version: z.literal(1), taskID: z.string(), scopeID: z.string() })
  const key = (maintenanceID: string, sessionID: string) => ["cortex_maintenance_holds", maintenanceID, sessionID]
  export async function index(session: Pick<Session.Info, "id" | "scope" | "cortex">) {
    const hold = session.cortex?.maintenance
    if (!hold) return
    SessionCortexContract.MaintenanceHold.parse(hold)
    await Storage.write(
      key(hold.maintenanceID, session.id),
      Index.parse({ version: 1, taskID: session.cortex!.taskID, scopeID: session.scope.id }),
    )
  }
  export async function remove(session: Pick<Session.Info, "id" | "scope" | "cortex">) {
    const hold = session.cortex?.maintenance
    if (hold) await Storage.remove(key(hold.maintenanceID, session.id))
  }
  export async function* list(maintenanceID: string) {
    for await (const row of Storage.records({ prefix: ["cortex_maintenance_holds", maintenanceID], limit: 128 })) {
      if (row.key.length !== 3) throw new Error("Invalid Cortex maintenance hold index")
      yield { sessionID: row.key[2], ...Index.parse(row.value) }
    }
  }
}

export const cortexMaintenanceHoldMigration: Migration = {
  id: "20261112-cortex-maintenance-holds-v1",
  scope: "derived",
  execution: "maintenance",
  emptyInput: [["sessions"]],
  description: "Index purpose-bound native Cortex maintenance holds without changing task identity",
  async up(progress) {
    let count = 0
    for await (const row of Storage.records<Record<string, unknown>>({ kind: "session", limit: 128 })) {
      const cortex = row.value.cortex
      if (!cortex || typeof cortex !== "object" || !("maintenance" in cortex) || !cortex.maintenance) continue
      await Storage.transaction(async () => {
        const [current] = await Storage.readMany<Session.Info>([row.key])
        if (current?.cortex?.maintenance) await CortexMaintenanceHolds.index(current)
      })
      progress(++count, 0)
    }
    progress(count, count)
  },
}

export function registerCortexMaintenanceMigrations() {
  MigrationRegistry.register("cortex-maintenance", [cortexMaintenanceHoldMigration])
}
