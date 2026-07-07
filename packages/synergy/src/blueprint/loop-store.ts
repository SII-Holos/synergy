import { Identifier } from "../id/id"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { ScopeContext } from "../scope/context"
import { Bus } from "../bus"
import { LoopEvent } from "./event"
import { LoopError } from "./error"
import { NoteStore } from "../note"
import { Session } from "../session"
import type { Info } from "./types"

type LoopStatus = Info["status"]

const TRANSITIONS: Record<LoopStatus, LoopStatus[]> = {
  armed: ["running", "cancelled"],
  running: ["waiting", "auditing", "completed", "failed", "cancelled"],
  waiting: ["running", "cancelled"],
  auditing: ["running", "completed", "failed", "cancelled", "waiting"],
  completed: ["completed"],
  failed: [],
  cancelled: [],
}

function isValidTransition(from: LoopStatus, to: LoopStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

function isActiveLoopStatus(status: LoopStatus) {
  return status === "armed" || status === "running" || status === "waiting" || status === "auditing"
}

export namespace BlueprintLoopStore {
  export async function create(input: {
    noteID: string
    noteVersion?: number
    title: string
    description?: string
    sessionID: string
    executionAgent?: string
    auditAgent?: string
    runMode?: Info["runMode"]
    parentSessionID?: string
    firstPrompt?: string
    loopIndex?: number
    model?: { providerID: string; modelID: string }
    orchestration?: Info["orchestration"]
  }): Promise<Info> {
    const scopeID = ScopeContext.current.scope.id
    const sid = Identifier.asScopeID(scopeID)
    const activeLoop = (await list(scopeID)).find(
      (loop) => loop.noteID === input.noteID && isActiveLoopStatus(loop.status),
    )
    if (activeLoop) {
      throw new LoopError.AlreadyActive({
        noteID: input.noteID,
        loopID: activeLoop.id,
        sessionID: activeLoop.sessionID,
        status: activeLoop.status,
      })
    }

    const now = Date.now()
    const id = Identifier.ascending("blueprint_loop")
    const loop: Info = {
      id,
      noteID: input.noteID,
      noteVersion: input.noteVersion,
      title: input.title,
      description: input.description,
      sessionID: input.sessionID,
      executionAgent: input.executionAgent,
      auditAgent: input.auditAgent?.trim() || "supervisor",
      scopeID,
      status: "armed",
      runMode: input.runMode,
      parentSessionID: input.parentSessionID,
      firstPrompt: input.firstPrompt,
      loopIndex: input.loopIndex,
      orchestration: input.orchestration,
      model: input.model,
      time: { created: now, updated: now },
    }
    await Storage.write(StoragePath.blueprintLoop(sid, id), loop)

    // Link to note: increment runCount, set lastRunAt, activeLoopID
    try {
      const note = await NoteStore.get(scopeID, loop.noteID)
      if (note.kind === "blueprint") {
        const bp = note.blueprint ?? {}
        await NoteStore.update(scopeID, loop.noteID, {
          blueprint: {
            runCount: (bp.runCount ?? 0) + 1,
            lastRunAt: now,
            activeLoopID: id,
          },
        })
      }
    } catch {
      // Note may not exist or not be a blueprint — best effort
    }

    await Bus.publish(LoopEvent.Created, { loop })
    return loop
  }

  export async function get(scopeID: string, id: string): Promise<Info> {
    return Storage.read<Info>(StoragePath.blueprintLoop(Identifier.asScopeID(scopeID), id))
  }

  export async function list(scopeID: string): Promise<Info[]> {
    const sid = Identifier.asScopeID(scopeID)
    const ids = await Storage.scan(StoragePath.blueprintLoopsRoot(sid))
    if (ids.length === 0) return []
    const keys = ids.map((loopId) => StoragePath.blueprintLoop(sid, loopId))
    const results = await Storage.readMany<Info>(keys)
    return results.filter((l): l is Info => l !== undefined)
  }

  export async function updateStatus(
    scopeID: string,
    id: string,
    patch: {
      status: LoopStatus
      error?: string
      audit?: Info["audit"]
      auditSessionID?: string | null
      auditTaskID?: string | null
      userPrompt?: string | null
    },
  ): Promise<Info> {
    const sid = Identifier.asScopeID(scopeID)
    const current = await Storage.read<Info>(StoragePath.blueprintLoop(sid, id))

    if (!isValidTransition(current.status, patch.status)) {
      throw new LoopError.InvalidTransition({
        from: current.status,
        to: patch.status,
      })
    }

    const isTerminal = patch.status === "completed" || patch.status === "failed" || patch.status === "cancelled"

    const updated = await Storage.update<Info>(StoragePath.blueprintLoop(sid, id), (draft) => {
      draft.status = patch.status
      draft.time.updated = Date.now()
      if (isTerminal) {
        draft.time.completed = Date.now()
        draft.auditTaskID = undefined
      }
      if (patch.status === "running" && !draft.time.started) {
        draft.time.started = Date.now()
      }
      if (patch.status === "running" && current.status === "auditing" && patch.auditSessionID === undefined) {
        draft.auditSessionID = undefined
        draft.auditTaskID = undefined
      }
      if (patch.audit) draft.audit = patch.audit
      if (patch.auditSessionID !== undefined) draft.auditSessionID = patch.auditSessionID ?? undefined
      if (patch.auditTaskID !== undefined) draft.auditTaskID = patch.auditTaskID ?? undefined
      if (patch.userPrompt !== undefined) draft.userPrompt = patch.userPrompt ?? undefined
      if (patch.error !== undefined) draft.error = patch.error
    })

    if (isTerminal || (patch.status === "running" && current.status === "auditing")) {
      try {
        if (current.auditSessionID) {
          await Session.update(current.auditSessionID, (draft) => {
            draft.blueprint = { ...draft.blueprint, loopID: undefined, loopRole: undefined }
          })
        }
      } catch {
        // best effort
      }
    }

    if (isTerminal) {
      try {
        const note = await NoteStore.get(scopeID, updated.noteID)
        if (note.kind === "blueprint" && note.blueprint?.activeLoopID === id) {
          await NoteStore.update(scopeID, updated.noteID, {
            blueprint: { activeLoopID: null },
          })
        }
      } catch {
        // best effort
      }

      try {
        if (updated.sessionID) {
          await Session.update(updated.sessionID, (draft) => {
            draft.blueprint = { ...draft.blueprint, loopID: undefined, loopRole: undefined }
          })
        }
      } catch {
        // best effort
      }
    }

    await Bus.publish(LoopEvent.Updated, { loop: updated })
    return updated
  }

  export async function complete(scopeID: string, id: string): Promise<Info> {
    return updateStatus(scopeID, id, { status: "completed" })
  }
}
