import { Environment } from "."
import { Storage } from "../storage/storage"
import { WorkspaceCatalog } from "../workspace/catalog"
import { SessionMigrationTarget } from "../migration/session-target"
import { MigrationRegistry } from "../migration/registry"
import type { Migration } from "../migration/types"
import { StoragePath } from "../storage/path"
import { EnvironmentExecution } from "./execution"
import { executionOriginRecordMigration, executionOriginPhysicalMigration } from "./execution-origin-migration"
import { environmentUseRecordMigration, environmentUsePhysicalMigration } from "./use-migration"
import { executionSourceRecordMigration, executionSourcePhysicalMigration } from "./execution-source-migration"
import {
  environmentTransferRecordMigration,
  environmentTransferPhysicalMigration,
  environmentTransferHistoryMigration,
} from "./transfer-migration"

export async function migrateSessionEnvironment(
  owner: { scopeID: string; sessionID: string },
  ancestors = new Set<string>(),
): Promise<string | null> {
  if (ancestors.has(owner.sessionID)) throw new Error("Session parent cycle prevents Environment migration")
  const key = ["sessions", owner.scopeID, owner.sessionID, "info"]
  return Storage.transaction(async () => {
    const [info] = await Storage.readMany<{
      environmentID?: string | null
      workspaceID?: string | null
      parentID?: string
    }>([key])
    if (!info) return null
    if (info.environmentID !== undefined) return info.environmentID
    const workspace = info.workspaceID ? (await WorkspaceCatalog.readMany([info.workspaceID]))[0] : undefined
    const environmentID =
      info.workspaceID && (!workspace || workspace.binding.state === "unbound")
        ? null
        : info.parentID
          ? await migrateSessionEnvironment(
              { scopeID: owner.scopeID, sessionID: info.parentID },
              new Set([...ancestors, owner.sessionID]),
            )
          : undefined
    const environment = await Environment.select({
      scopeID: owner.scopeID,
      ownerID: owner.sessionID,
      workspaceID: info.workspaceID,
      environmentID,
    })
    await Storage.write(key, { ...info, environmentID: environment?.id ?? null })
    return environment?.id ?? null
  })
}

export const environmentMigrations: Migration[] = [
  {
    id: "20260928-environment-active-executions",
    emptyInput: [["environment_execution"]],
    scope: "global",
    description: "Index unfinished Environment operations for receipt and checkpoint recovery",
    async up(progress) {
      let count = 0
      for await (const row of Storage.records({ prefix: ["environment_execution"], limit: 64 })) {
        if (row.key.length !== 3) throw new Error("Environment execution index found an unknown record address")
        await Storage.transaction(async () => {
          const info = await EnvironmentExecution.get(row.key[2], row.key[1])
          if (info.state !== "completed")
            await Storage.write(StoragePath.environmentExecutionActive(info.scopeID, info.id), true)
        })
        progress(++count, 0)
      }
      progress(count, count)
    },
  },
  {
    id: "20260927-session-environment-binding",
    emptyInput: [["sessions"]],
    scope: "session",
    description: "Record explicit Environment selection without allocating compute",
    async upSession(owner) {
      await migrateSessionEnvironment(owner)
    },
    async up(progress) {
      let done = 0
      for (const scopeID of await SessionMigrationTarget.scopes()) {
        const sessions = await SessionMigrationTarget.sessions(scopeID)
        for (const sessionID of sessions) {
          await migrateSessionEnvironment({ scopeID, sessionID })
          progress(++done, sessions.length)
        }
      }
    },
  },
  executionOriginRecordMigration,
  executionOriginPhysicalMigration,
  executionSourceRecordMigration,
  executionSourcePhysicalMigration,
  environmentUseRecordMigration,
  environmentUsePhysicalMigration,
  environmentTransferRecordMigration,
  environmentTransferPhysicalMigration,
  environmentTransferHistoryMigration,
]

export function registerEnvironmentMigrations() {
  MigrationRegistry.register("environment", environmentMigrations)
}
