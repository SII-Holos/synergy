import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Identifier } from "@/id/id"
import { LibraryDB } from "@/library/database"
import { Global } from "@/global"
import type { Migration } from "@/migration"
import type { Info as SessionInfo } from "../session/types"
import type { Scope } from "./index"
import { Log } from "@/util/log"
import { MigrationRegistry } from "@/migration/registry"
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
const LEGACY_GLOBAL_SCOPE_ID = "global"
const HOME_SCOPE_ID = "home"

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

      // Also check library for scopeIDs
      try {
        const conn = LibraryDB.connection()
        const rows = conn.prepare("SELECT DISTINCT scope_id FROM experience").all() as { scope_id: string }[]
        for (const row of rows) dataScopeIDs.add(row.scope_id)
      } catch {}

      dataScopeIDs.delete(LEGACY_GLOBAL_SCOPE_ID)
      dataScopeIDs.delete(HOME_SCOPE_ID)
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
      const totalSteps = orphanIDs.length + 2 // +1 session info patching, +1 library cleanup
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

      // 7. Clean up library experiences for all orphan scopes
      // Orphan experiences are unreachable — no active scope will ever query them.
      // Rather than reassigning scope_id (which requires vec table surgery),
      // we delete them. The session history in Reclaimed scope preserves context.
      let totalRemoved = 0
      for (const orphanID of orphanIDs) {
        try {
          const removed = LibraryDB.Experience.removeByScope(orphanID)
          totalRemoved += removed
        } catch (err) {
          log.warn("failed to remove orphan library experiences", { scopeID: orphanID, error: err })
        }
      }
      if (totalRemoved > 0) log.info("removed orphan library experiences", { total: totalRemoved })

      done++
      progress(done, totalSteps)
      log.info("orphan scope reclaim complete", { scopes: orphanIDs.length, libraryRemoved: totalRemoved })
    },
  },
  {
    id: "20260624-scope-global-to-home",
    description: "Rename legacy global scope data to the home scope",
    async up(progress) {
      const dataDir = Global.Path.data
      const fromSID = Identifier.asScopeID(LEGACY_GLOBAL_SCOPE_ID)
      const toSID = Identifier.asScopeID(HOME_SCOPE_ID)
      const steps = 12
      let done = 0

      await moveFileBasedData(LEGACY_GLOBAL_SCOPE_ID, HOME_SCOPE_ID, dataDir)
      await moveFile(
        path.join(dataDir, ...StoragePath.sessionNavIndex(fromSID)) + ".json",
        path.join(dataDir, ...StoragePath.sessionNavIndex(toSID)) + ".json",
      )
      done++
      progress(done, steps)

      await moveDir(
        path.join(dataDir, ...StoragePath.blueprintLoopsRoot(fromSID)),
        path.join(dataDir, ...StoragePath.blueprintLoopsRoot(toSID)),
      )
      await moveFile(
        path.join(dataDir, ...StoragePath.permission(fromSID)) + ".json",
        path.join(dataDir, ...StoragePath.permission(toSID)) + ".json",
      )
      await moveDir(
        path.join(Global.Path.snapshot, LEGACY_GLOBAL_SCOPE_ID),
        path.join(Global.Path.snapshot, HOME_SCOPE_ID),
      )
      done++
      progress(done, steps)

      await patchSessionIndexes()
      done++
      progress(done, steps)

      await patchHomeSessionInfos()
      done++
      progress(done, steps)

      await patchHomeSessionNavIndex()
      done++
      progress(done, steps)

      await patchEndpointSessionIndexes()
      done++
      progress(done, steps)

      await patchHomeAgendaItems()
      done++
      progress(done, steps)

      await patchAgendaSessionRefs()
      done++
      progress(done, steps)

      await patchHomeNotes()
      done++
      progress(done, steps)

      await patchHomeBlueprintLoops()
      done++
      progress(done, steps)

      await renameLibraryScope()
      done++
      progress(done, steps)

      await clearStatsCaches()
      await removeLegacyGlobalRoots()
      done++
      progress(done, steps)

      log.info("legacy global scope migrated to home")
    },
  },
]
MigrationRegistry.register("scope", migrations)

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function normalizeLegacyScopeFields(value: unknown): boolean {
  if (!isRecord(value)) return false
  let changed = false
  for (const [key, child] of Object.entries(value)) {
    if (key === "scopeID" && child === LEGACY_GLOBAL_SCOPE_ID) {
      value[key] = HOME_SCOPE_ID
      changed = true
      continue
    }
    if (key === "scopeType" && child === LEGACY_GLOBAL_SCOPE_ID) {
      value[key] = HOME_SCOPE_ID
      changed = true
      continue
    }
    if (key === "category" && child === LEGACY_GLOBAL_SCOPE_ID) {
      value[key] = "home"
      changed = true
      continue
    }
    if (isRecord(child)) {
      if (child.id === LEGACY_GLOBAL_SCOPE_ID) {
        child.id = HOME_SCOPE_ID
        child.directory = Global.Path.home
        child.worktree = Global.Path.home
        changed = true
      }
      if (child.type === LEGACY_GLOBAL_SCOPE_ID) {
        child.type = HOME_SCOPE_ID
        changed = true
      }
      if (normalizeLegacyScopeFields(child)) changed = true
      continue
    }
    if (Array.isArray(child)) {
      for (const item of child) {
        if (normalizeLegacyScopeFields(item)) changed = true
      }
    }
  }
  return changed
}

function normalizeHomeSessionInfo(info: Record<string, unknown>): boolean {
  let changed = normalizeLegacyScopeFields(info)
  const scope = isRecord(info.scope) ? info.scope : undefined
  if (!scope || scope.id === HOME_SCOPE_ID || scope.type === HOME_SCOPE_ID) {
    info.scope = {
      ...(scope ?? {}),
      id: HOME_SCOPE_ID,
      type: HOME_SCOPE_ID,
      directory: Global.Path.home,
      worktree: Global.Path.home,
    }
    changed = true
  }

  const workspace = isRecord(info.workspace) ? info.workspace : undefined
  if (
    workspace?.scopeID === HOME_SCOPE_ID ||
    workspace?.scopeID === LEGACY_GLOBAL_SCOPE_ID ||
    scope?.id === HOME_SCOPE_ID
  ) {
    info.workspace = {
      ...(workspace ?? {}),
      type: workspace?.type ?? "main",
      path: Global.Path.home,
      scopeID: HOME_SCOPE_ID,
    }
    changed = true
  }

  if (info.category === LEGACY_GLOBAL_SCOPE_ID) {
    info.category = "home"
    changed = true
  }
  return changed
}

async function patchSessionIndexes() {
  const sessionIDs = await Storage.scan(StoragePath.sessionIndexRoot())
  for (const sessionID of sessionIDs) {
    const key = StoragePath.sessionIndex(Identifier.asSessionID(sessionID))
    const entry = await Storage.read<Record<string, unknown>>(key).catch(() => undefined)
    if (!entry || entry.scopeID !== LEGACY_GLOBAL_SCOPE_ID) continue
    entry.scopeID = HOME_SCOPE_ID
    entry.directory = Global.Path.home
    await Storage.write(key, entry)
  }
}

async function patchHomeSessionInfos() {
  const scope = Identifier.asScopeID(HOME_SCOPE_ID)
  const sessionIDs = await Storage.scan(StoragePath.sessionsRoot(scope))
  for (const sessionID of sessionIDs) {
    const key = StoragePath.sessionInfo(scope, Identifier.asSessionID(sessionID))
    const info = await Storage.read<Record<string, unknown>>(key).catch(() => undefined)
    if (!info) continue
    if (normalizeHomeSessionInfo(info)) await Storage.write(key, info)
  }
}

async function patchHomeSessionNavIndex() {
  const key = StoragePath.sessionNavIndex(Identifier.asScopeID(HOME_SCOPE_ID))
  const index = await Storage.read<Record<string, unknown>>(key).catch(() => undefined)
  if (!index) return
  if (normalizeLegacyScopeFields(index)) await Storage.write(key, index)
}

async function patchEndpointSessionIndexes() {
  const endpointKeys = await Storage.scan(["endpoint_session"])
  for (const endpointKey of endpointKeys) {
    const sessionIDs = await Storage.scan(["endpoint_session", endpointKey])
    for (const sessionID of sessionIDs) {
      const key = ["endpoint_session", endpointKey, sessionID]
      const entry = await Storage.read<Record<string, unknown>>(key).catch(() => undefined)
      if (!entry || entry.scopeID !== LEGACY_GLOBAL_SCOPE_ID) continue
      entry.scopeID = HOME_SCOPE_ID
      await Storage.write(key, entry)
    }
  }
}

async function patchHomeAgendaItems() {
  const scope = Identifier.asScopeID(HOME_SCOPE_ID)
  const itemIDs = await Storage.scan(StoragePath.agendaItemsRoot(scope))
  for (const itemID of itemIDs) {
    const key = StoragePath.agendaItem(scope, itemID)
    const item = await Storage.read<Record<string, unknown>>(key).catch(() => undefined)
    if (!item) continue
    if (normalizeLegacyScopeFields(item)) await Storage.write(key, item)
  }
}

async function patchAgendaSessionRefs() {
  const itemIDs = await Storage.scan(["agenda", "sessions"])
  for (const itemID of itemIDs) {
    const sessionIDs = await Storage.scan(StoragePath.agendaSessionsRoot(itemID))
    for (const sessionID of sessionIDs) {
      const key = StoragePath.agendaSession(itemID, sessionID)
      const entry = await Storage.read<Record<string, unknown>>(key).catch(() => undefined)
      if (!entry || entry.scopeID !== LEGACY_GLOBAL_SCOPE_ID) continue
      entry.scopeID = HOME_SCOPE_ID
      await Storage.write(key, entry)
    }
  }
}

async function patchHomeNotes() {
  const scope = Identifier.asScopeID(HOME_SCOPE_ID)
  const noteIDs = await Storage.scan(StoragePath.notesRoot(scope))
  let rebuiltIndex = false
  for (const noteID of noteIDs) {
    if (noteID.startsWith("_")) continue
    const key = StoragePath.note(scope, noteID)
    const note = await Storage.read<Record<string, unknown>>(key).catch(() => undefined)
    if (!note) continue
    if (normalizeLegacyScopeFields(note)) {
      await Storage.write(key, note)
      rebuiltIndex = true
    }
  }
  if (rebuiltIndex) await Storage.remove(StoragePath.note(scope, "_index")).catch(() => undefined)
}

async function patchHomeBlueprintLoops() {
  const scope = Identifier.asScopeID(HOME_SCOPE_ID)
  const loopIDs = await Storage.scan(StoragePath.blueprintLoopsRoot(scope))
  for (const loopID of loopIDs) {
    const key = StoragePath.blueprintLoop(scope, loopID)
    const loop = await Storage.read<Record<string, unknown>>(key).catch(() => undefined)
    if (!loop) continue
    if (normalizeLegacyScopeFields(loop)) await Storage.write(key, loop)
  }
}

async function renameLibraryScope() {
  try {
    const changed = LibraryDB.Experience.renameScope(LEGACY_GLOBAL_SCOPE_ID, HOME_SCOPE_ID)
    if (changed > 0) log.info("renamed library experience scope", { changed })
  } catch (err) {
    log.warn("failed to rename library experience scope", { error: String(err) })
  }
}

async function clearStatsCaches() {
  await Storage.remove(StoragePath.statsWatermark()).catch(() => undefined)
  await Storage.remove(StoragePath.statsSnapshot()).catch(() => undefined)
  await Storage.remove(StoragePath.librarySnapshot()).catch(() => undefined)
  await Storage.removeTree(StoragePath.statsDigestsRoot()).catch(() => undefined)
  await Storage.removeTree(StoragePath.statsDailyRoot()).catch(() => undefined)
}

async function removeLegacyGlobalRoots() {
  await Storage.removeTree(StoragePath.sessionsRoot(Identifier.asScopeID(LEGACY_GLOBAL_SCOPE_ID))).catch(
    () => undefined,
  )
  await Storage.remove(StoragePath.sessionsPageIndex(Identifier.asScopeID(LEGACY_GLOBAL_SCOPE_ID))).catch(
    () => undefined,
  )
  await Storage.remove(StoragePath.sessionNavIndex(Identifier.asScopeID(LEGACY_GLOBAL_SCOPE_ID))).catch(() => undefined)
  await Storage.removeTree(StoragePath.notesRoot(Identifier.asScopeID(LEGACY_GLOBAL_SCOPE_ID))).catch(() => undefined)
  await Storage.removeTree(StoragePath.agendaItemsRoot(Identifier.asScopeID(LEGACY_GLOBAL_SCOPE_ID))).catch(
    () => undefined,
  )
  await Storage.removeTree(["agenda", "runs", LEGACY_GLOBAL_SCOPE_ID]).catch(() => undefined)
  await Storage.remove(StoragePath.agendaRunIndex(Identifier.asScopeID(LEGACY_GLOBAL_SCOPE_ID))).catch(() => undefined)
  await Storage.removeTree(StoragePath.blueprintLoopsRoot(Identifier.asScopeID(LEGACY_GLOBAL_SCOPE_ID))).catch(
    () => undefined,
  )
  await Storage.remove(StoragePath.permission(Identifier.asScopeID(LEGACY_GLOBAL_SCOPE_ID))).catch(() => undefined)
}

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
