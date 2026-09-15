import { randomUUID } from "node:crypto"
import { z } from "zod"
import { Storage } from "../storage/storage"
import { SnapshotLifecycle } from "./snapshot-lifecycle"
import { StorageIntegrityError } from "../storage/errors"

export namespace SessionStaging {
  const Job = z
    .object({ version: z.literal(1), scopeID: z.string(), sessionIDs: z.array(z.string()).min(1), created: z.number() })
    .strict()
  export async function begin(scopeID: string, sessionIDs: string[]) {
    const id = randomUUID()
    const job = Job.parse({ version: 1, scopeID, sessionIDs: [...new Set(sessionIDs)], created: Date.now() })
    await Storage.transaction(async () => {
      for (const key of await Storage.list(["storage_staging"])) {
        const pending = Job.parse(await Storage.read(key))
        if (pending.sessionIDs.some((sessionID) => job.sessionIDs.includes(sessionID)))
          throw new StorageIntegrityError("A staged session ID is reserved by another import")
      }
      for (const sessionID of job.sessionIDs) {
        if (
          (
            await Storage.readMany([
              ["session_index", sessionID],
              ["sessions", scopeID, sessionID, "info"],
            ])
          ).some((record) => record !== undefined)
        )
          throw new StorageIntegrityError("A staged session ID already belongs to existing data")
      }
      await Storage.write(["storage_staging", id], job)
    })
    return id
  }

  export async function finish(id: string) {
    if (!Storage.inTransaction())
      throw new StorageIntegrityError("Staged sessions must become visible in their final business transaction")
    const job = Job.parse(await Storage.read(["storage_staging", id]))
    for (const sessionID of job.sessionIDs) await Storage.read(["sessions", job.scopeID, sessionID, "info"])
    await Storage.remove(["storage_staging", id])
  }

  export async function discard(id: string) {
    const [raw] = await Storage.readMany([["storage_staging", id]])
    if (!raw) return
    const job = Job.parse(raw)
    await Storage.transaction(async () => {
      for (const sessionID of job.sessionIDs) {
        if ((await Storage.readMany([["sessions", job.scopeID, sessionID, "info"]]))[0] !== undefined)
          throw new StorageIntegrityError("Cannot discard a staging job containing a published session")
        await SnapshotLifecycle.scheduleDelete(job.scopeID, sessionID)
        await Storage.removeTree(["sessions", job.scopeID, sessionID])
      }
    })
    for (const sessionID of job.sessionIDs) await SnapshotLifecycle.completeDelete(job.scopeID, sessionID)
    await Storage.remove(["storage_staging", id])
  }

  export async function recover() {
    for (const id of await Storage.scan(["storage_staging"])) await discard(id)
  }
}
