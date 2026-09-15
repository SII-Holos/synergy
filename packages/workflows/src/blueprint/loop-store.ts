import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { LoopEvent } from "./event"
import { cancelDeadline } from "./deadline"
import { LoopError } from "./error"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
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

export function isActiveLoopStatus(status: LoopStatus) {
  return status === "armed" || status === "running" || status === "waiting" || status === "auditing"
}

function terminalHookLock(scopeID: string, loopID: string): string {
  return `blueprint_terminal_hook:${scopeID}:${loopID}`
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
    source?: Info["source"]
    sourceDigest?: string
    budget?: Info["budget"]
    pluginOwner?: Info["pluginOwner"]
    executionTools?: Info["executionTools"]
    auditTools?: Info["auditTools"]
  }): Promise<Info> {
    return Storage.transaction(async () => {
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
        source: input.source ?? "user",
        sourceDigest: input.sourceDigest,
        budget: input.budget,
        pluginOwner: input.pluginOwner,
        model: input.model,
        executionTools: input.executionTools,
        auditTools: input.auditTools,
        time: { created: now, updated: now },
      }
      await Storage.write(StoragePath.blueprintLoop(sid, id), loop)

      await NoteStore.recordBlueprintRun({ scopeID, noteID: loop.noteID, loopID: id, started: now })

      await Bus.publish(LoopEvent.Created, { loop })
      return loop
    })
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

  export async function recordStopRequest(
    scopeID: string,
    id: string,
    stopRequest: NonNullable<Info["stopRequest"]>,
  ): Promise<Info> {
    return Storage.transaction(async () => {
      const sid = Identifier.asScopeID(scopeID)
      const updated = await Storage.update<Info>(StoragePath.blueprintLoop(sid, id), (draft) => {
        if (draft.status !== "running") {
          throw new Error(`Cannot request review for BlueprintLoop ${draft.id} while its status is "${draft.status}"`)
        }
        if (draft.stopRequest) return
        draft.stopRequest = stopRequest
        draft.time.updated = Date.now()
      })
      await Bus.publish(LoopEvent.Updated, { loop: updated })
      return updated
    })
  }

  export async function recordAuditToolRecovery(
    scopeID: string,
    id: string,
    input: {
      auditSessionID: string
      expectedAuditTaskID: string
      auditTaskID: string
      attempts: number
    },
  ): Promise<Info> {
    return Storage.transaction(async () => {
      const sid = Identifier.asScopeID(scopeID)
      const updated = await Storage.update<Info>(StoragePath.blueprintLoop(sid, id), (draft) => {
        if (
          draft.status !== "auditing" ||
          !draft.stopRequest ||
          draft.auditSessionID !== input.auditSessionID ||
          draft.auditTaskID !== input.expectedAuditTaskID
        ) {
          throw new Error(`BlueprintLoop ${draft.id} review binding changed before recovery`)
        }
        draft.auditTaskID = input.auditTaskID
        draft.stopRequest.reviewToolRecoveryAttempts = input.attempts
        draft.time.updated = Date.now()
      })
      await Bus.publish(LoopEvent.Updated, { loop: updated })
      return updated
    })
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
      summary?: string
      stopRequest?: Info["stopRequest"] | null
    },
  ): Promise<Info> {
    const updated = await Storage.transaction(async () => {
      const sid = Identifier.asScopeID(scopeID)
      const current = await Storage.read<Info>(StoragePath.blueprintLoop(sid, id))

      if (!isValidTransition(current.status, patch.status)) {
        throw new LoopError.InvalidTransition({
          from: current.status,
          to: patch.status,
        })
      }

      const isTerminal = patch.status === "completed" || patch.status === "failed" || patch.status === "cancelled"
      if (isTerminal) Storage.afterCommit(() => cancelDeadline(scopeID, id))

      const updated = await Storage.update<Info>(StoragePath.blueprintLoop(sid, id), (draft) => {
        draft.status = patch.status
        draft.time.updated = Date.now()
        if (isTerminal) {
          draft.time.completed = Date.now()
          draft.auditTaskID = undefined
          draft.stopRequest = undefined
        }
        if (patch.status === "running" && !draft.time.started) {
          draft.time.started = Date.now()
        }
        if (patch.status === "running" && current.status === "auditing" && patch.auditSessionID === undefined) {
          draft.auditSessionID = undefined
          draft.auditTaskID = undefined
          draft.stopRequest = undefined
        }
        if (patch.audit) draft.audit = patch.audit
        if (patch.auditSessionID !== undefined) draft.auditSessionID = patch.auditSessionID ?? undefined
        if (patch.auditTaskID !== undefined) draft.auditTaskID = patch.auditTaskID ?? undefined
        if (patch.userPrompt !== undefined) draft.userPrompt = patch.userPrompt ?? undefined
        if (patch.summary !== undefined) draft.summary = patch.summary
        if (patch.stopRequest !== undefined) draft.stopRequest = patch.stopRequest ?? undefined
        if (patch.error !== undefined) draft.error = patch.error
      })

      async function unbind(sessionID: string | undefined, archive = false) {
        if (!sessionID) return
        try {
          await Session.update(sessionID, (draft) => {
            draft.blueprint = { ...draft.blueprint, loopID: undefined, loopRole: undefined }
            if (archive) draft.time.archived = Date.now()
          })
        } catch (error) {
          if (!(error instanceof Storage.NotFoundError)) throw error
        }
      }
      if (isTerminal || (patch.status === "running" && current.status === "auditing"))
        await unbind(current.auditSessionID)
      if (isTerminal) {
        await NoteStore.recordBlueprintRun({
          scopeID,
          noteID: updated.noteID,
          loopID: id,
          ended: true,
          archive: updated.source === "plugin",
        })
        await unbind(updated.sessionID, updated.source === "plugin")
      }

      await Bus.publish(LoopEvent.Updated, { loop: updated })
      return updated
    })
    if (
      ["completed", "failed", "cancelled"].includes(updated.status) &&
      updated.source === "plugin" &&
      updated.pluginOwner
    )
      await deliverTerminalHook(scopeID, id)
    return updated
  }

  export async function deliverTerminalHook(scopeID: string, id: string): Promise<void> {
    using _ = await Lock.write(terminalHookLock(scopeID, id))
    const path = StoragePath.blueprintLoop(Identifier.asScopeID(scopeID), id)
    const loop = await Storage.read<Info>(path)
    if (!loop.pluginOwner || loop.terminalHookDeliveredAt !== undefined) return

    const delivery = await Plugin.deliverHookForPlugin(
      loop.pluginOwner.pluginId,
      loop.pluginOwner.pluginGeneration,
      "blueprint.after",
      { loop },
    ).catch((hookError) => ({
      status: "failed" as const,
      handlerCount: 0,
      succeededHandlerCount: 0,
      error: `Hook blueprint.after delivery failed: ${hookError instanceof Error ? hookError.message : String(hookError)}`,
    }))

    await Storage.update<Info>(path, (draft) => {
      if (draft.terminalHookDeliveredAt !== undefined) return
      if (delivery.status === "delivered" && delivery.handlerCount > 0) {
        draft.terminalHookDeliveredAt = Date.now()
        draft.terminalHookError = undefined
        return
      }
      draft.terminalHookError =
        delivery.status === "delivered" ? "Hook blueprint.after reported delivery without a handler" : delivery.error
    })
  }

  export async function complete(scopeID: string, id: string): Promise<Info> {
    return updateStatus(scopeID, id, { status: "completed" })
  }
}
