import { Storage } from "../storage/storage"
import { StorageCompat } from "../storage/compat"
import { MigrationRegistry } from "../migration/registry"
import type { Migration } from "../migration/types"
import { SessionCortexIndex } from "./cortex-index"
import { SessionCompat } from "./compat-import"
import type { Info } from "./types"

export const sessionCortexIndexMigrations: Migration[] = [
  {
    id: "20261111-session-cortex-summary-pages",
    description: "Build private-payload-free Cortex summary pages from native child metadata",
    scope: "session",
    execution: "session",
    async upSession(owner, progress) {
      if (await SessionCortexIndex.ready(owner.scopeID, owner.sessionID)) return
      const { Session } = await import(".")
      await Storage.transaction(async () => {
        if (await SessionCortexIndex.ready(owner.scopeID, owner.sessionID)) return
        let count = 0
        await SessionCortexIndex.rebuild(
          owner.scopeID,
          owner.sessionID,
          (async function* () {
            for await (const entry of Session.childIndexEntries(owner.scopeID, owner.sessionID)) {
              const [locator] = await Storage.readMany<StorageCompat.Locator>([StorageCompat.locatorKey(entry.id)])
              const child =
                locator && locator.status !== "imported"
                  ? await SessionCompat.pendingInfo(owner.scopeID, entry.id)
                  : (await Storage.readMany<Info>([["sessions", owner.scopeID, entry.id, "info"]]))[0]
              if (child?.scope.id === owner.scopeID && child.parentID === owner.sessionID) yield child
              progress(++count, 0)
            }
          })(),
        )
        progress(count, count)
      })
    },
    async up(progress) {
      let count = 0
      for await (const row of Storage.records<Info>({ kind: "session", limit: 128 })) {
        await this.upSession!({ scopeID: row.value.scope.id, sessionID: row.value.id }, () => {})
        progress(++count, 0)
      }
      progress(count, count)
    },
  },
]

export function registerSessionCortexIndexMigrations() {
  MigrationRegistry.register("session-cortex-index", sessionCortexIndexMigrations)
}
