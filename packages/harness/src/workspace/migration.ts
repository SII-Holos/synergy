import type { Migration } from "../migration/types"
import { MigrationRegistry } from "../migration/registry"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { WorkspaceCheckpoints } from "./checkpoint"
import { WorkspaceMounts } from "./mount"
import { EnvironmentExecution } from "../environment/execution"
import { WorkspaceOperations } from "./operations"
import { WorkspaceCatalog } from "./catalog"
import { RuntimeContext } from "../lifecycle/context"

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
  {
    id: "20260929-workspace-checkpoint-attempts",
    description: "Recapture unfinished legacy checkpoints without replaying their side effects",
    scope: "global",
    execution: "startup",
    async up(progress) {
      const executions = await Storage.list(StoragePath.environmentExecutionActive())
      const operations = await Storage.list(StoragePath.workspaceOperationActive())
      let done = 0
      for (const key of executions) {
        const info = await EnvironmentExecution.get(key[2], key[1])
        if (info.state !== "saved" && info.state !== "completed")
          for (const reference of info.workspaces ?? []) {
            if (reference.readOnly) continue
            const [workspace] = await WorkspaceCatalog.readMany([reference.workspaceID])
            if (workspace)
              await WorkspaceCheckpoints.migrate(workspace, WorkspaceMounts.checkpointID(info.id, reference.id))
          }
        progress(++done, executions.length + operations.length)
      }
      for (const key of operations) {
        const info = await WorkspaceOperations.get(key[2], key[1])
        if ("mount" in info.input && info.state !== "completed" && info.state !== "failed") {
          const [workspace] = await WorkspaceCatalog.readMany([info.workspaceID])
          if (workspace) await WorkspaceCheckpoints.migrate(workspace, info.id)
        }
        progress(++done, executions.length + operations.length)
      }
    },
  },
  {
    id: "20261003-persistent-volume-identity",
    description: "Upgrade verified local directory identities without changing Workspace generations",
    scope: "global",
    execution: "startup",
    async up(progress) {
      const source = RuntimeContext.current().host.workspaceLocation
      if (!source) return
      const hostID = await source.hostID()
      const keys = await Storage.list(["workspace"])
      for (let offset = 0; offset < keys.length; offset += 128) {
        const records = await Storage.readMany<unknown>(keys.slice(offset, offset + 128))
        for (const raw of records) {
          if (!raw) continue
          const record = WorkspaceCatalog.Info.parse(raw)
          const binding = record.binding
          if (
            record.lifecycle !== "active" ||
            binding.state !== "bound" ||
            binding.hostID !== hostID ||
            !binding.path ||
            !binding.physicalID ||
            binding.physicalID.startsWith("volume-v1:")
          )
            continue
          const actual = await source.identify(binding.path, true).catch((error: NodeJS.ErrnoException) => {
            if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error.code ?? "")) return undefined
            throw error
          })
          if (
            actual?.path !== binding.path ||
            !actual.physicalID?.startsWith("volume-v1:") ||
            actual.legacyPhysicalID !== binding.physicalID
          )
            continue
          await WorkspaceCatalog.upgradePhysicalIdentity(record, actual.physicalID)
        }
        progress(Math.min(offset + 128, keys.length), keys.length)
      }
    },
  },
]

export function registerWorkspaceMigrations() {
  MigrationRegistry.register("workspace", workspaceMigrations)
}
