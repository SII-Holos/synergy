import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Identifier } from "@/id/id"
import { EngramDB } from "@/engram/database"
import { Global } from "@/global"
import type { Migration } from "@/migration"
import type { Info as SessionInfo } from "../session/types"
import type { Scope } from "./index"
import { Log } from "@/util/log"
import { existsSync } from "fs"
import path from "path"
import fs from "fs/promises"

const log = Log.create({ service: "scope.migration" })

/**
 * Scope ID for reclaimed/orphan data.
 * Orphan scopes have no active project record and their worktree directory no longer exists.
 * All their data is consolidated into this single scope so it remains browsable.
 */
const RECLAIMED_SCOPE_ID = "__reclaimed__"

export const migrations: Migration[] = [
  {
    id: "20260430-scope-add-type-directory",
    description: "Add type and directory fields to scope records that predate these schema fields",
    async up(progress) {
      const ids = await Storage.scan(StoragePath.scopeRoot())
      let done = 0
      for (const rawID of ids) {
        const scopePath = StoragePath.scope(Identifier.asScopeID(rawID))
        const data = await Storage.read<Record<string, unknown>>(scopePath).catch(() => undefined)
        if (data && !data.type) {
          await Storage.update(scopePath, (draft: Record<string, unknown>) => {
            draft.type = "project"
            draft.directory = draft.directory ?? draft.worktree
          })
        }
        done++
        progress(done, ids.length)
      }
    },
  },
  {
    id: "20260424-scope-reclaim-orphans",
    description: "Consolidate orphan scope data (no active project, no worktree) into a reclaimed scope",
    async up(progress) {
      const now = Date.now()
      const dataDir = Global.Path.data
      const reclaimedSID = Identifier.asScopeID(RECLAIMED_SCOPE_ID)

      // 1. Collect all scopeIDs that have file-based data
      const dataScopeIDs = new Set<string>()
      for (const prefix of [["sessions"], ["notes"], ["agenda", "items"]]) {
        for (const sid of await Storage.scan(prefix)) {
          if (sid !== ".DS_Store") dataScopeIDs.add(sid)
        }
      }

      // Also check engram for scopeIDs
      try {
        const conn = EngramDB.connection()
        const rows = conn.prepare("SELECT DISTINCT scope_id FROM experience").all() as { scope_id: string }[]
        for (const row of rows) dataScopeIDs.add(row.scope_id)
      } catch {}

      dataScopeIDs.delete("global")
      dataScopeIDs.delete(RECLAIMED_SCOPE_ID)

      // 2. Collect active project scopeIDs: non-archived + worktree exists
      const activeProjectIDs = new Set<string>()
      for (const rawID of await Storage.scan(StoragePath.scopeRoot())) {
        const info = await Storage.read<{
          id: string
          worktree?: string
          time?: { archived?: number }
        }>(StoragePath.scope(Identifier.asScopeID(rawID))).catch(() => undefined)
        if (!info || info.time?.archived) continue
        if (info.worktree && existsSync(info.worktree)) {
          activeProjectIDs.add(info.id)
        }
      }

      // 3. Orphans: have data but no active project with existing worktree
      const orphanIDs = [...dataScopeIDs].filter((sid) => !activeProjectIDs.has(sid))
      if (orphanIDs.length === 0) {
        progress(1, 1)
        log.info("no orphan scopes found")
        return
      }

      log.info("identified orphan scopes", { count: orphanIDs.length, ids: orphanIDs })

      // 4. Create the reclaimed scope record
      const reclaimedDir = path.join(Global.Path.home, ".synergy", "reclaimed")
      const reclaimedScope: Scope.Project = {
        type: "project",
        id: RECLAIMED_SCOPE_ID,
        directory: reclaimedDir,
        worktree: reclaimedDir,
        name: "Reclaimed",
        icon: { color: "gray" },
        sandboxes: [],
        time: { created: now, updated: now },
      }
      await Storage.write(StoragePath.scope(reclaimedSID), {
        id: RECLAIMED_SCOPE_ID,
        worktree: reclaimedDir,
        name: "Reclaimed",
        icon: { color: "gray" },
        time: { created: now, updated: now },
        sandboxes: [],
      })

      // 5. Move file-based data for each orphan scope
      const totalSteps = orphanIDs.length + 2 // +1 session info patching, +1 engram cleanup
      let done = 0

      for (const orphanID of orphanIDs) {
        await moveFileBasedData(orphanID, RECLAIMED_SCOPE_ID, dataDir)
        await removeOrphanProjectRecord(orphanID)
        done++
        progress(done, totalSteps)
        log.info("reclaimed orphan scope file data", { scopeID: orphanID })
      }

      // 6. Update session_index entries: orphan scopeIDs → __reclaimed__
      // Also patch session info scope fields to point to the reclaimed scope
      const orphanSet = new Set(orphanIDs)
      const sessionIndexIDs = await Storage.scan(StoragePath.sessionIndexRoot())
      let indexUpdated = 0
      let infoPatched = 0

      for (const sessionID of sessionIndexIDs) {
        const indexPath = StoragePath.sessionIndex(Identifier.asSessionID(sessionID))
        const entry = await Storage.read<{ sessionID: string; scopeID: string; directory?: string }>(indexPath).catch(
          () => undefined,
        )
        if (!entry || !orphanSet.has(entry.scopeID)) continue

        // Update session index
        entry.scopeID = RECLAIMED_SCOPE_ID
        await Storage.write(indexPath, entry)
        indexUpdated++

        // Update session info's scope field so runtime code resolves the correct storage paths
        const infoPath = StoragePath.sessionInfo(reclaimedSID, Identifier.asSessionID(sessionID))
        const info = await Storage.read<SessionInfo>(infoPath).catch(() => undefined)
        if (info && info.scope) {
          const oldScope = info.scope as Scope.Project
          info.scope = {
            ...reclaimedScope,
            // Preserve name/icon from original scope if available
            name: oldScope.name ?? reclaimedScope.name,
            icon: oldScope.icon ?? reclaimedScope.icon,
          }
          await Storage.write(infoPath, info)
          infoPatched++
        }
      }
      if (indexUpdated > 0) log.info("updated session records", { indexUpdated, infoPatched })
      done++
      progress(done, totalSteps)

      // 7. Clean up engram experiences for all orphan scopes
      // Orphan experiences are unreachable — no active scope will ever query them.
      // Rather than reassigning scope_id (which requires vec table surgery),
      // we delete them. The session history in Reclaimed scope preserves context.
      let totalRemoved = 0
      for (const orphanID of orphanIDs) {
        try {
          const removed = EngramDB.Experience.removeByScope(orphanID)
          totalRemoved += removed
        } catch (err) {
          log.warn("failed to remove orphan engram experiences", { scopeID: orphanID, error: err })
        }
      }
      if (totalRemoved > 0) log.info("removed orphan engram experiences", { total: totalRemoved })

      done++
      progress(done, totalSteps)
      log.info("orphan scope reclaim complete", { scopes: orphanIDs.length, engramRemoved: totalRemoved })
    },
  },
]

async function moveFileBasedData(fromScopeID: string, toScopeID: string, dataDir: string) {
  const fromSID = Identifier.asScopeID(fromScopeID)
  const toSID = Identifier.asScopeID(toScopeID)

  // Move sessions directory (contains session dirs with info/messages/etc)
  await moveDir(
    path.join(dataDir, ...StoragePath.sessionsRoot(fromSID)),
    path.join(dataDir, ...StoragePath.sessionsRoot(toSID)),
  )

  // Move sessions page index
  await moveFile(
    path.join(dataDir, ...StoragePath.sessionsPageIndex(fromSID)) + ".json",
    path.join(dataDir, ...StoragePath.sessionsPageIndex(toSID)) + ".json",
  )

  // Move notes directory
  await moveDir(
    path.join(dataDir, ...StoragePath.notesRoot(fromSID)),
    path.join(dataDir, ...StoragePath.notesRoot(toSID)),
  )

  // Move agenda items directory
  await moveDir(
    path.join(dataDir, ...StoragePath.agendaItemsRoot(fromSID)),
    path.join(dataDir, ...StoragePath.agendaItemsRoot(toSID)),
  )

  // Move agenda runs directory
  const runsPrefix = ["agenda", "runs", fromScopeID]
  const runsTarget = ["agenda", "runs", toScopeID]
  await moveDir(path.join(dataDir, ...runsPrefix), path.join(dataDir, ...runsTarget))

  // Move agenda run index
  await moveFile(
    path.join(dataDir, ...StoragePath.agendaRunIndex(fromSID)) + ".json",
    path.join(dataDir, ...StoragePath.agendaRunIndex(toSID)) + ".json",
  )
}

async function moveDir(from: string, to: string) {
  if (!existsSync(from)) return
  await fs.mkdir(path.dirname(to), { recursive: true })
  // If target already exists, merge contents into it
  if (existsSync(to)) {
    const entries = await fs.readdir(from)
    for (const entry of entries) {
      await fs.rename(path.join(from, entry), path.join(to, entry)).catch(() => {})
    }
    await fs.rm(from, { recursive: true, force: true }).catch(() => {})
  } else {
    await fs.rename(from, to).catch((err) => {
      log.warn("failed to move directory", { from, to, error: err })
    })
  }
}

async function moveFile(from: string, to: string) {
  if (!existsSync(from)) return
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.rename(from, to).catch(() => {})
}

async function removeOrphanProjectRecord(scopeID: string) {
  await Storage.remove(StoragePath.scope(Identifier.asScopeID(scopeID))).catch(() => {})
}
