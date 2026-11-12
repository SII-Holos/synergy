import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { OrganizationSyncPath as Keys } from "./storage/path"
import { registerKnowledgeActiveMigrations } from "./knowledge-active"
import { handoffTargetMigration } from "./handoff-target-record"

const Sequence = z.object({ localSequence: z.number().int().nonnegative(), draftID: z.string().min(1) })
const migrations: Migration[] = [
  handoffTargetMigration,
  {
    id: "20261111-organization-sync-order",
    description: "Index pending sync drafts in publication order and register resumable roots",
    scope: "global",
    execution: "startup",
    async up(progress) {
      let count = 0
      for await (const row of Storage.records<unknown>({ prefix: ["organization-sync"], limit: 256 })) {
        const [domain, orgID, kind, sessionID, section] = row.key
        if (domain !== "organization-sync" || !orgID || kind !== "sessions" || !sessionID) continue
        if (row.key.length === 5 && section === "state")
          await Storage.write(Keys.registeredRoot(orgID, sessionID), { sessionID })
        if (row.key.length === 6 && section === "drafts") {
          const draft = Sequence.parse(row.value)
          await Storage.write(Keys.orderedDraft(orgID, sessionID, draft.localSequence), { draftID: draft.draftID })
        }
        progress(++count, count + 1)
      }
      progress(count + 1, count + 1)
    },
  },
]

export function registerSyncMigrations() {
  registerKnowledgeActiveMigrations()
  MigrationRegistry.register("organization-sync", migrations)
}
