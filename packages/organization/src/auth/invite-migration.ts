import { z } from "zod"
import type { Migration } from "@ericsanchezok/synergy-harness/migration/types"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { OrganizationProtocol } from "@ericsanchezok/synergy-organization-protocol"
import { OrganizationStoragePath as Keys } from "../storage/path"
import { OrganizationRecord as Record } from "../storage/records"

const legacy = Record.Invite.omit({ inviteID: true, orgID: true, revision: true, createdAt: true }).extend({
  schemaVersion: z.literal(1),
})

export const inviteCatalogMigration: Migration = {
  id: "20261111-organization-invitation-catalog",
  description: "Give retained invitations independent public identities and authorized metadata indexes",
  scope: "global",
  execution: "startup",
  dependsOn: ["20261108-organization-deployment"],
  async up(progress) {
    const deployment = OrganizationProtocol.Deployment.parse(await Storage.read(Keys.deployment()))
    let after: string[] | undefined
    let count = 0
    for (;;) {
      const entries = await Storage.query({ prefix: Keys.invites(), after, limit: 128 })
      if (!entries.length) break
      await Storage.transaction(async () => {
        for (const entry of entries) {
          const stored = await Storage.read<unknown>(entry.key)
          const old = legacy.safeParse(stored)
          const invite = old.success
            ? Record.Invite.parse({
                ...old.data,
                schemaVersion: 2,
                inviteID: crypto.randomUUID(),
                orgID: deployment.orgID,
                revision: 1,
              })
            : Record.Invite.parse(stored)
          const indexed = { tokenHash: invite.tokenHash }
          await Storage.write(entry.key, invite)
          await Storage.write(Keys.inviteID(invite.orgID, invite.inviteID), indexed)
          await Storage.write(Keys.issuedInvite(invite.orgID, invite.createdBy, invite.inviteID), indexed)
        }
      })
      count += entries.length
      after = entries.at(-1)!.key
      progress(count, count + (entries.length === 128 ? 1 : 0))
    }
    progress(count, count)
  },
}
