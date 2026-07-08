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

function trimmedString(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed ? trimmed : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function isLiveLoopStatus(status: BlueprintLoopInfo["status"]) {
  return status === "running" || status === "waiting" || status === "auditing"
}

function isActiveLoopStatus(status: unknown): status is BlueprintLoopInfo["status"] {
  return status === "armed" || status === "running" || status === "waiting" || status === "auditing"
}

function loopUpdatedAt(loop: BlueprintLoopInfo) {
  return asNumber(asRecord(loop.time)?.updated) ?? 0
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

async function clearSessionLoop(loop: BlueprintLoopInfo, sessionID = loop.sessionID) {
  if (!sessionID) return false

  const scope = Identifier.asScopeID(loop.scopeID)
  const sessionPath = StoragePath.sessionInfo(scope, Identifier.asSessionID(sessionID))
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

async function setNoteActiveLoop(scopeID: string, noteID: string, loopID: string) {
  const scope = Identifier.asScopeID(scopeID)
  const notePath = StoragePath.note(scope, noteID)
  const note = await Storage.read<Record<string, unknown>>(notePath).catch(() => undefined)
  if (!note) return false

  const blueprint = asRecord(note.blueprint) ?? {}
  if (note.kind !== "blueprint" && !note.blueprint) return false

  if (blueprint.activeLoopID === loopID) return false
  blueprint.activeLoopID = loopID
  note.blueprint = blueprint
  await Storage.write(notePath, note)
  await Storage.remove(StoragePath.note(scope, "_index")).catch(() => undefined)
  return true
}

async function cancelDuplicateActiveLoop(loop: BlueprintLoopInfo) {
  const scope = Identifier.asScopeID(loop.scopeID)
  const loopPath = StoragePath.blueprintLoop(scope, loop.id)
  const now = Date.now()
  loop.status = "cancelled"
  loop.time.updated = now
  loop.time.completed ??= now
  await Storage.write(loopPath, loop)

  let clearedSessions = 0
  if (await clearSessionLoop(loop)) clearedSessions++
  if (loop.auditSessionID && (await clearSessionLoop(loop, loop.auditSessionID))) clearedSessions++
  return clearedSessions
}

async function userPromptFromStartMessage(loop: BlueprintLoopInfo): Promise<string | undefined> {
  const scope = Identifier.asScopeID(loop.scopeID)
  const session = Identifier.asSessionID(loop.sessionID)
  const messageIDs = await Storage.scan(StoragePath.sessionMessagesRoot(scope, session)).catch(() => [])
  for (const messageID of messageIDs) {
    const message = await Storage.read<Record<string, unknown>>(
      StoragePath.messageInfo(scope, session, Identifier.asMessageID(messageID)),
    ).catch(() => undefined)
    const metadata = asRecord(message?.metadata)
    if (message?.role !== "user") continue
    if (metadata?.source !== "blueprint_loop_start") continue
    if (metadata?.loopID !== loop.id) continue
    const userPrompt = trimmedString(metadata.userPrompt)
    if (userPrompt) return userPrompt
  }
}

async function migrateBlueprintLoopSource(progress: (current: number, total: number) => void) {
  const scopeIDs = await Storage.scan(["blueprint_loops"])
  const loops: Array<{ scopeID: string; loopID: string }> = []

  for (const scopeID of scopeIDs) {
    const scope = Identifier.asScopeID(scopeID)
    const loopIDs = await Storage.scan(StoragePath.blueprintLoopsRoot(scope))
    for (const loopID of loopIDs) loops.push({ scopeID, loopID })
  }

  if (loops.length === 0) return

  let done = 0
  let changed = 0
  for (const { scopeID, loopID } of loops) {
    const scope = Identifier.asScopeID(scopeID)
    const loopPath = StoragePath.blueprintLoop(scope, loopID)
    const loop = await Storage.read<Record<string, unknown>>(loopPath).catch(() => undefined)
    if (!loop) {
      done++
      progress(done, loops.length)
      continue
    }

    const orchestration = asRecord(loop.orchestration)
    const source = orchestration?.kind === "lattice" ? "lattice" : "user"
    if (loop.source !== source || "orchestration" in loop) {
      loop.source = source
      delete loop.orchestration
      await Storage.write(loopPath, loop)
      changed++
    }

    done++
    progress(done, loops.length)
  }

  log.info("BlueprintLoop source migration complete", { totalLoops: loops.length, changed })
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
  {
    id: "20260703-blueprint-single-active-loop",
    description: "Collapse duplicate active BlueprintLoops to one active run per Blueprint",
    domain: "blueprint_loop",
    dependsOn: ["20260628-blueprint-loop-audit-agent"],
    async up(progress) {
      const scopeIDs = await Storage.scan(["blueprint_loops"])
      const loops: BlueprintLoopInfo[] = []

      for (const scopeID of scopeIDs) {
        const scope = Identifier.asScopeID(scopeID)
        const loopIDs = await Storage.scan(StoragePath.blueprintLoopsRoot(scope))
        for (const loopID of loopIDs) {
          try {
            loops.push(await Storage.read<BlueprintLoopInfo>(StoragePath.blueprintLoop(scope, loopID)))
          } catch (err) {
            log.warn("failed to read BlueprintLoop for single-active migration", {
              scopeID,
              loopID,
              error: String(err),
            })
          }
        }
      }

      const activeByBlueprint = new Map<string, BlueprintLoopInfo[]>()
      for (const loop of loops) {
        if (!isActiveLoopStatus(loop.status)) continue
        const key = `${loop.scopeID}\0${loop.noteID}`
        activeByBlueprint.set(key, [...(activeByBlueprint.get(key) ?? []), loop])
      }

      let done = 0
      let cancelled = 0
      let clearedSessions = 0
      let normalizedNotes = 0
      const groups = [...activeByBlueprint.values()].filter((group) => group.length > 1)
      for (const group of groups) {
        const first = group[0]
        const scope = Identifier.asScopeID(first.scopeID)
        const note = await Storage.read<Record<string, unknown>>(StoragePath.note(scope, first.noteID)).catch(
          () => undefined,
        )
        const activeLoopID = asString(asRecord(note?.blueprint)?.activeLoopID)
        const keep =
          group.find((loop) => loop.id === activeLoopID) ??
          [...group].sort((a, b) => loopUpdatedAt(b) - loopUpdatedAt(a))[0]

        if (await setNoteActiveLoop(keep.scopeID, keep.noteID, keep.id)) normalizedNotes++

        for (const loop of group) {
          if (loop.id === keep.id) continue
          clearedSessions += await cancelDuplicateActiveLoop(loop)
          cancelled++
        }

        done++
        progress(done, groups.length)
      }

      log.info("BlueprintLoop single-active migration complete", {
        activeGroups: activeByBlueprint.size,
        duplicateGroups: groups.length,
        cancelled,
        clearedSessions,
        normalizedNotes,
      })
    },
  },
  {
    id: "20260704-blueprint-loop-user-prompt",
    description: "Backfill BlueprintLoop start userPrompt from execution session start messages",
    domain: "blueprint_loop",
    dependsOn: ["20260703-blueprint-single-active-loop"],
    async up(progress) {
      const scopeIDs = await Storage.scan(["blueprint_loops"])
      const loops: BlueprintLoopInfo[] = []

      for (const scopeID of scopeIDs) {
        const scope = Identifier.asScopeID(scopeID)
        const loopIDs = await Storage.scan(StoragePath.blueprintLoopsRoot(scope))
        for (const loopID of loopIDs) {
          try {
            loops.push(await Storage.read<BlueprintLoopInfo>(StoragePath.blueprintLoop(scope, loopID)))
          } catch (err) {
            log.warn("failed to read BlueprintLoop for userPrompt migration", {
              scopeID,
              loopID,
              error: String(err),
            })
          }
        }
      }

      let done = 0
      let changed = 0
      for (const loop of loops) {
        try {
          if (!trimmedString(loop.userPrompt)) {
            const userPrompt = await userPromptFromStartMessage(loop)
            if (userPrompt) {
              loop.userPrompt = userPrompt
              await Storage.write(StoragePath.blueprintLoop(Identifier.asScopeID(loop.scopeID), loop.id), loop)
              changed++
            }
          }
        } catch (err) {
          log.warn("failed to migrate BlueprintLoop userPrompt", {
            scopeID: loop.scopeID,
            loopID: loop.id,
            error: String(err),
          })
        }

        done++
        if (done % 10 === 0 || done === loops.length) {
          progress(done, loops.length)
        }
      }

      log.info("BlueprintLoop userPrompt migration complete", { totalLoops: loops.length, changed })
    },
  },
  {
    id: "20260708-blueprint-loop-source",
    description: "Migrate BlueprintLoop orchestration ownership into source",
    domain: "blueprint_loop",
    dependsOn: ["20260704-blueprint-loop-user-prompt"],
    async up(progress) {
      await migrateBlueprintLoopSource(progress)
    },
  },
]

MigrationRegistry.register("blueprint_loop", migrations)
