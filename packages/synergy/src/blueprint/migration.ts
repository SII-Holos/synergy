import { Identifier } from "../id/id"
import { MigrationRegistry } from "../migration/registry"
import { StoragePath } from "../storage/path"
import { Storage } from "../storage/storage"
import { Log } from "../util/log"
import type { Info as BlueprintLoopInfo } from "./types"
import type { Migration } from "../migration"

const log = Log.create({ service: "blueprint.migration" })

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isLiveLoopStatus(status: BlueprintLoopInfo["status"]) {
  return status === "running" || status === "waiting" || status === "auditing"
}

async function clearNoteActiveLoop(loop: BlueprintLoopInfo) {
  const scope = Identifier.asScopeID(loop.scopeID)
  const notePath = StoragePath.note(scope, loop.noteID)
  const note = await Storage.read<Record<string, unknown>>(notePath).catch(() => undefined)
  const blueprint = asRecord(note?.blueprint)
  if (!note || blueprint?.activeLoopID !== loop.id) return false

  delete blueprint.activeLoopID
  note.blueprint = blueprint
  await Storage.write(notePath, note)
  await Storage.remove(StoragePath.note(scope, "_index")).catch(() => undefined)
  return true
}

async function clearSessionLoop(loop: BlueprintLoopInfo) {
  if (!loop.sessionID) return false

  const scope = Identifier.asScopeID(loop.scopeID)
  const sessionPath = StoragePath.sessionInfo(scope, Identifier.asSessionID(loop.sessionID))
  const session = await Storage.read<Record<string, unknown>>(sessionPath).catch(() => undefined)
  const blueprint = asRecord(session?.blueprint)
  if (!session || blueprint?.loopID !== loop.id) return false

  delete blueprint.loopID
  delete blueprint.loopRole
  if (Object.keys(blueprint).length === 0) {
    delete session.blueprint
  } else {
    session.blueprint = blueprint
  }
  await Storage.write(sessionPath, session)
  return true
}

export const migrations: Migration[] = [
  {
    id: "20260624-blueprint-cancel-stale-armed-loops",
    description: "Cancel stale armed BlueprintLoops and clear dangling inactive references",
    domain: "blueprint_loop",
    async up(progress) {
      const scopeIDs = await Storage.scan(["blueprint_loops"])
      const loops: Array<{ scopeID: string; loopID: string }> = []

      for (const scopeID of scopeIDs) {
        const scope = Identifier.asScopeID(scopeID)
        const loopIDs = await Storage.scan(StoragePath.blueprintLoopsRoot(scope))
        for (const loopID of loopIDs) {
          loops.push({ scopeID, loopID })
        }
      }

      let done = 0
      let cancelled = 0
      let clearedReferences = 0
      for (const { scopeID, loopID } of loops) {
        const scope = Identifier.asScopeID(scopeID)
        const loopPath = StoragePath.blueprintLoop(scope, loopID)
        try {
          const loop = await Storage.read<BlueprintLoopInfo>(loopPath)
          if (loop.status === "armed") {
            const now = Date.now()
            loop.status = "cancelled"
            loop.time.updated = now
            loop.time.completed ??= now
            await Storage.write(loopPath, loop)
            cancelled++
          }
          if (!isLiveLoopStatus(loop.status)) {
            const clearedNote = await clearNoteActiveLoop(loop)
            const clearedSession = await clearSessionLoop(loop)
            if (clearedNote) clearedReferences++
            if (clearedSession) clearedReferences++
          }
        } catch (err) {
          log.warn("failed to cancel stale armed BlueprintLoop", { scopeID, loopID, error: String(err) })
        }

        done++
        if (done % 10 === 0 || done === loops.length) {
          progress(done, loops.length)
        }
      }

      log.info("stale armed BlueprintLoop cleanup complete", { totalLoops: loops.length, cancelled, clearedReferences })
    },
  },
  {
    id: "20260628-blueprint-loop-audit-agent",
    description: "Replace supervisorSessionID with auditSessionID and snapshot auditAgent on BlueprintLoops",
    domain: "blueprint_loop",
    dependsOn: ["20260624-blueprint-cancel-stale-armed-loops"],
    async up(progress) {
      const scopeIDs = await Storage.scan(["blueprint_loops"])
      const loops: Array<{ scopeID: string; loopID: string }> = []

      for (const scopeID of scopeIDs) {
        const scope = Identifier.asScopeID(scopeID)
        const loopIDs = await Storage.scan(StoragePath.blueprintLoopsRoot(scope))
        for (const loopID of loopIDs) {
          loops.push({ scopeID, loopID })
        }
      }

      let done = 0
      let changed = 0
      for (const { scopeID, loopID } of loops) {
        const scope = Identifier.asScopeID(scopeID)
        const loopPath = StoragePath.blueprintLoop(scope, loopID)
        try {
          const loop = await Storage.read<Record<string, unknown>>(loopPath)
          let didChange = false
          const legacySupervisorSessionID = asString(loop.supervisorSessionID)
          if (legacySupervisorSessionID && !asString(loop.auditSessionID)) {
            loop.auditSessionID = legacySupervisorSessionID
            didChange = true
          }
          if ("supervisorSessionID" in loop) {
            delete loop.supervisorSessionID
            didChange = true
          }
          if (!asString(loop.auditAgent)) {
            loop.auditAgent = "supervisor"
            didChange = true
          }
          if (didChange) {
            await Storage.write(loopPath, loop)
            changed++
          }
        } catch (err) {
          log.warn("failed to migrate BlueprintLoop audit agent fields", { scopeID, loopID, error: String(err) })
        }

        done++
        if (done % 10 === 0 || done === loops.length) {
          progress(done, loops.length)
        }
      }

      log.info("BlueprintLoop audit agent migration complete", { totalLoops: loops.length, changed })
    },
  },
]

MigrationRegistry.register("blueprint_loop", migrations)
