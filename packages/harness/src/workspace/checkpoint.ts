import { randomUUID } from "node:crypto"
import { z } from "zod"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { WorkspaceCatalog } from "./catalog"

export namespace WorkspaceCheckpoints {
  const Attempt = z.object({
    id: z.string(),
    workspace: WorkspaceCatalog.Info,
    state: z.enum(["pending", "conflict", "saved"]),
    saved: WorkspaceCatalog.Info.optional(),
  })
  const Record = z.object({ attempts: z.array(Attempt).min(1) })
  export type Attempt = z.infer<typeof Attempt> & { key: string[] }

  export async function begin(workspace: WorkspaceCatalog.Info, operationID: string): Promise<Attempt> {
    const key = StoragePath.workspaceCheckpoint(workspace.scopeID, workspace.id, operationID)
    return Storage.transaction(async () => {
      const [raw] = await Storage.readMany<unknown>([key])
      const record = raw ? Record.parse(raw) : { attempts: [] }
      let attempt = record.attempts.at(-1)
      if (!attempt || attempt.state === "conflict") {
        attempt = { id: attempt ? `checkpoint_${randomUUID()}` : operationID, workspace, state: "pending" }
        record.attempts.push(attempt)
        await Storage.write(key, record)
      }
      return { ...attempt, key }
    })
  }

  export async function conflict(attempt: Attempt) {
    return change(attempt, { state: "conflict" })
  }
  export async function saved(attempt: Attempt, workspace: WorkspaceCatalog.Info) {
    return change(attempt, { state: "saved", saved: workspace })
  }
  async function change(attempt: Attempt, changes: Partial<z.infer<typeof Attempt>>) {
    await Storage.transaction(async () => {
      const record = Record.parse(await Storage.read(attempt.key))
      const current = record.attempts.find((item) => item.id === attempt.id)
      if (!current) throw new Error("Workspace checkpoint attempt is unavailable")
      if (current.state === "saved") return
      Object.assign(current, changes)
      await Storage.write(attempt.key, record)
    })
  }

  export async function migrate(workspace: WorkspaceCatalog.Info, operationID: string) {
    const key = StoragePath.workspaceCheckpoint(workspace.scopeID, workspace.id, operationID)
    if ((await Storage.readMany([key]))[0]) return
    await Storage.write(key, { attempts: [{ id: operationID, workspace, state: "conflict" }] })
  }
}
