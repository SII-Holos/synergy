import type { Migration } from "../migration/types"
import { MigrationRegistry } from "../migration/registry"
import { Storage } from "../storage/storage"
import { WorkspaceCatalog } from "./catalog"

export const workspaceMigrations: Migration[] = [
  {
    id: "20260927-workspace-storage-backend",
    description: "Record directory storage independently of Workspace identity and binding",
    scope: "global",
    execution: "startup",
    async up(progress) {
      const keys = await Storage.list(["workspace"])
      for (let offset = 0; offset < keys.length; offset += 128) {
        await Storage.transaction(async (tx) => {
          const batch = keys.slice(offset, offset + 128)
          const values = await tx.readMany<unknown>(batch)
          for (let index = 0; index < values.length; index++) {
            if (!values[index]) continue
            const record = WorkspaceCatalog.Info.parse(values[index])
            if (record.backend) continue
            await tx.write(batch[index], {
              ...record,
              backend: { provider: "directory", spec: {} },
              content: { revision: 0, manifest: null },
            })
          }
        })
        progress(Math.min(offset + 128, keys.length), keys.length)
      }
    },
  },
]

export function registerWorkspaceMigrations() {
  MigrationRegistry.register("workspace", workspaceMigrations)
}
