import { Identifier } from "../id/id"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { Instance } from "../scope/instance"
import { Bus } from "../bus"
import { LoopEvent } from "./event"
import type { Info } from "./types"

export namespace BlueprintLoopStore {
  export async function create(input: {
    noteID: string
    noteVersion?: number
    title: string
    description?: string
    sessionID: string
  }): Promise<Info> {
    const scopeID = Instance.scope.id
    const now = Date.now()
    const id = Identifier.ascending("blueprint_loop")
    const loop: Info = {
      id,
      noteID: input.noteID,
      noteVersion: input.noteVersion,
      title: input.title,
      description: input.description,
      sessionID: input.sessionID,
      scopeID,
      status: "running",
      time: { created: now, started: now, updated: now },
    }
    await Storage.write(StoragePath.blueprintLoop(Identifier.asScopeID(scopeID), id), loop)
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
    const keys = ids.map((id) => StoragePath.blueprintLoop(sid, id))
    const results = await Storage.readMany<Info>(keys)
    return results.filter((l): l is Info => l !== undefined)
  }

  export async function updateStatus(
    scopeID: string,
    id: string,
    patch: {
      status: Info["status"]
      error?: string
      audit?: Info["audit"]
      supervisorSessionID?: string
    },
  ): Promise<Info> {
    const updated = await Storage.update<Info>(
      StoragePath.blueprintLoop(Identifier.asScopeID(scopeID), id),
      (draft) => {
        draft.status = patch.status
        draft.time.updated = Date.now()
        if (patch.status === "completed" || patch.status === "failed" || patch.status === "cancelled") {
          draft.time.completed = Date.now()
        }
        if (patch.audit) draft.audit = patch.audit
        if (patch.supervisorSessionID !== undefined) draft.supervisorSessionID = patch.supervisorSessionID
      },
    )
    await Bus.publish(LoopEvent.Updated, { loop: updated })
    return updated
  }

  export async function complete(scopeID: string, id: string): Promise<Info> {
    return updateStatus(scopeID, id, { status: "completed" })
  }
}
