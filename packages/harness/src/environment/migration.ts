import { Environment } from "."
import { Storage } from "../storage/storage"
import { WorkspaceCatalog } from "../workspace/catalog"
import { SessionMigrationTarget } from "../migration/session-target"
import { MigrationRegistry } from "../migration/registry"
import type { Migration } from "../migration/types"

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
      environmentID,
    })
    await Storage.write(key, { ...info, environmentID: environment?.id ?? null })
    return environment?.id ?? null
  })
}

export const environmentMigrations: Migration[] = [
  {
    id: "20260927-session-environment-binding",
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
]

export function registerEnvironmentMigrations() {
  MigrationRegistry.register("environment", environmentMigrations)
}
