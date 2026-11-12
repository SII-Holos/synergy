import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { UpgradeWork } from "@ericsanchezok/synergy-harness/storage/upgrade-work"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import {
  OrganizationExecutionProtocol as Execution,
  OrganizationIdentity as Identity,
} from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationRecord as Record } from "./storage/records"
import { OrganizationStoragePath as Keys } from "./storage/path"
import { fail } from "./error"

export namespace OrganizationExecutionIndex {
  const root = ["organization", "retained-execution-grants"]
  const schemaKey = ["organization", "execution-grant-index-schema"]
  const Schema = z.strictObject({ version: z.literal(1), complete: z.literal(true) })
  const Entry = z.strictObject({ version: z.literal(1), grantID: Identity.ID })
  const prefix = (sessionID: string, epoch: number) => [...root, Identity.ID.parse(sessionID), String(epoch)]
  export async function update(grant: Execution.Grant) {
    if (!Storage.inWriteTransaction())
      fail("INVALID_REQUEST", "Execution index must join its canonical grant transaction")
    const key = [...prefix(grant.sessionID, grant.bindingEpoch), grant.grantID]
    if (grant.state === "provisional" || (grant.state === "bound" && grant.retention.state === "held"))
      await Storage.write(key, Entry.parse({ version: 1, grantID: grant.grantID }))
    else await Storage.remove(key)
  }
  export async function page(session: Record.SessionDirectory, input: { after?: string; limit: number }) {
    const [schema] = await Storage.readMany([schemaKey])
    if (!Schema.safeParse(schema).success)
      fail("HANDOFF_BLOCKED", "Execution grant index requires its owning migration")
    const selected = prefix(session.sessionID, session.bindingEpoch)
    if ((await Storage.count({ prefix: selected })) !== session.retainedExecutionGrants)
      fail("SERVICE_UNAVAILABLE", "Execution grant index does not cover its canonical retained count")
    const rows = await Storage.query({
      prefix: selected,
      limit: input.limit,
      ...(input.after ? { after: [...selected, Identity.ID.parse(input.after)] } : {}),
    })
    return rows.map((row) => {
      const entry = Entry.parse(row.value)
      if (row.key.length !== selected.length + 1 || row.key.at(-1) !== entry.grantID)
        fail("SERVICE_UNAVAILABLE", "Execution grant index has another native key")
      return entry
    })
  }
  export const migration: Migration = {
    id: "20261112-organization-retained-grant-index",
    description: "Build a bounded Session and epoch index from canonical retained grants",
    scope: "global",
    execution: "startup",
    dependsOn: ["20261112-organization-execution-handoff-closure"],
    async up(progress) {
      UpgradeWork.signal()?.throwIfAborted()
      await Storage.remove(schemaKey)
      await Storage.removeTree(root)
      let count = 0
      for await (const row of Storage.records({ prefix: ["organization", "execution-grants"], limit: 128 })) {
        UpgradeWork.signal()?.throwIfAborted()
        const grant = Record.parse(Record.ExecutionGrant, row.key, row.value)
        if (row.key.length !== 3 || row.key[2] !== grant.grantID)
          fail("SERVICE_UNAVAILABLE", "Execution grant has another canonical key")
        await Storage.transaction(() => update(grant))
        progress(++count, 0)
      }
      for await (const row of Storage.records({ prefix: Keys.sessions(), limit: 128 })) {
        UpgradeWork.signal()?.throwIfAborted()
        const session = Record.parse(Record.SessionDirectory, row.key, row.value)
        if (
          (await Storage.count({ prefix: prefix(session.sessionID, session.bindingEpoch) })) !==
          session.retainedExecutionGrants
        )
          fail("SERVICE_UNAVAILABLE", "Retained grants disagree with their canonical Session count")
      }
      await Storage.transaction(() => Storage.write(schemaKey, Schema.parse({ version: 1, complete: true })), {
        commitGuard() {
          UpgradeWork.signal()?.throwIfAborted()
        },
      })
      progress(count, count)
    },
  }
}
