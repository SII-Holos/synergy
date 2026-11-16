import { z } from "zod"
import { isDeepStrictEqual } from "node:util"
import { OrganizationSessionProtocol as Sessions } from "@ericsanchezok/synergy-organization-protocol"
import { SessionTransferCore as Core } from "@ericsanchezok/synergy-harness/session/transfer"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { RolloutArtifact } from "@ericsanchezok/synergy-harness/session/rollout/artifact"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { OrganizationSyncPath as Keys } from "./storage/path"
import { registerKnowledgeActiveMigrations } from "./knowledge-active"
import { handoffTargetMigration, handoffTargetRecoveryMigration } from "./handoff-target-record"

import { originalAttachmentContentRepairMigration } from "./sync-attachment-repair"
export { repairOrganizationSyncAttachmentContent } from "./sync-attachment-repair"

const Sequence = z.object({ localSequence: z.number().int().nonnegative(), draftID: z.string().min(1) })
const migrations: Migration[] = [
  handoffTargetMigration,
  handoffTargetRecoveryMigration,
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
  {
    id: "20261114-organization-sync-attachment-content",
    description: "Retain exact original attachment content references for immutable sync batches",
    scope: "global",
    execution: "startup",
    async up(progress) {
      const { AttachmentRecord, retainAttachmentContent } = await import("./sync-projection")
      let count = 0
      for await (const row of Storage.records<unknown>({ prefix: ["organization-sync"], limit: 128 })) {
        if (row.key.length !== 6 || row.key[2] !== "sessions" || row.key[4] !== "attachments") continue
        const value = AttachmentRecord.parse(row.value)
        const orgID = row.key[1]!
        if (!isDeepStrictEqual(row.key, Keys.attachment(orgID, value.sessionID, value.attachmentID)))
          throw new Error("Legacy attachment alias changed its original key")
        if (value.artifact.status !== "complete" || !value.artifact.sha256) continue
        const session = await Storage.snapshot(async () => {
          const pair = await Storage.readMany([
            StoragePath.sessionIndex(Identifier.asSessionID(value.sessionID)),
            StoragePath.sessionInfo(Identifier.asScopeID(value.scopeID), Identifier.asSessionID(value.sessionID)),
          ])
          if (pair.every((entry) => entry === undefined)) return
          return (await Core.storedInfo({ scopeID: value.scopeID, sessionID: value.sessionID })).info
        })
        if (!session) continue
        if (session.scope.id !== value.scopeID || Sessions.Binding.parse(session.organization).orgID !== orgID)
          throw new Error("Legacy attachment alias changed its original native owner")
        const owner = { kind: "session", scopeID: value.scopeID, sessionID: value.sessionID } as const
        const actual = await RolloutArtifact.get(owner, value.artifact.id).catch((error: unknown) => {
          if (error instanceof Storage.NotFoundError) return
          throw error
        })
        if (!actual) continue
        if (!isDeepStrictEqual(actual, value.artifact))
          throw new Error("Legacy attachment content lacks its original native reference")
        let bytes = 0
        for await (const chunk of RolloutArtifact.read(owner, actual)) bytes += chunk.byteLength
        if (bytes !== actual.bytes) throw new Error("Legacy attachment content has an incomplete original body")
        await retainAttachmentContent(orgID, value, async (key, retained) => {
          await Storage.write(key, retained)
        })
        progress(++count, count + 1)
      }
      progress(count + 1, count + 1)
    },
  },
  originalAttachmentContentRepairMigration,
]

export function registerSyncMigrations() {
  registerKnowledgeActiveMigrations()
  MigrationRegistry.register("organization-sync", migrations)
}
