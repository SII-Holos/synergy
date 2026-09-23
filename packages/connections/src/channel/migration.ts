import { z } from "zod"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import type { Migration } from "@ericsanchezok/synergy-harness/migration"

const LegacyCheckout = z
  .object({
    directory: z.string(),
    scopeID: z.string(),
    workspaceID: z.string().optional(),
  })
  .passthrough()

export const migrations: Migration[] = [
  {
    id: "20260923-github-channel-workspace-reference",
    description: "Associate historical GitHub checkouts with their canonical Workspace",
    scope: "global",
    async up(progress) {
      let done = 0
      for (const account of await Storage.scan(StoragePath.githubChannelAccountsRoot())) {
        for (const hash of await Storage.scan(StoragePath.githubChannelWorkspaceIndexRoot(account))) {
          const key = StoragePath.githubChannelWorkspaceIndexEntry(account, hash)
          const parsed = LegacyCheckout.safeParse(await Storage.read(key))
          if (!parsed.success || parsed.data.workspaceID !== undefined) continue
          const { directory, scopeID } = parsed.data
          const workspace = await WorkspaceBinding.migrate({ type: "main", scopeID, path: directory }, scopeID)
          if (!workspace) throw new Error("GitHub checkout upgrade requires a Workspace")
          await Storage.update<Record<string, unknown>>(key, (record) => {
            if (record.workspaceID === undefined) {
              record.workspaceID = workspace.id
              record.directory = workspace.path
            }
          })
          progress(++done, done)
        }
      }
    },
  },
]

export function registerChannelMigrations() {
  MigrationRegistry.register("channel", migrations)
}
