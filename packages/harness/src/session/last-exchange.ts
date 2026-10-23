import { Identifier } from "../id/id"
import { RuntimeContext } from "../lifecycle/context"
import { prepareSessionMigrations } from "../migration"
import { Storage } from "../storage/storage"
import { StoragePath } from "../storage/path"
import { StorageConflictError } from "../storage/errors"
import { MessageV2 } from "./message-v2"
import { PartContent } from "./part-content"
import { SessionHistory } from "./history"
import { SessionManager } from "./manager"
import { SessionRecords } from "./records"
import { SessionCompat } from "./compat-import"
import type { Info } from "./types"

export namespace SessionLastExchange {
  const pending = RuntimeContext.state(() => new Map<string, { dirty: boolean; task: Promise<void> }>())

  export function refresh(sessionID: string): Promise<void> {
    if (Storage.inTransaction())
      throw new StorageConflictError("Last exchange must refresh outside a storage transaction")
    const jobs = pending()
    const previous = jobs.get(sessionID)
    if (previous) {
      previous.dirty = true
      return previous.task
    }
    const job = { dirty: true, task: Promise.resolve() }
    jobs.set(sessionID, job)
    job.task = (async () => {
      while (job.dirty) {
        job.dirty = false
        await update(sessionID)
      }
    })().finally(() => {
      if (jobs.get(sessionID) === job) jobs.delete(sessionID)
    })
    return job.task
  }

  async function update(sessionID: string) {
    await SessionCompat.requireImported(sessionID)
    const session = await SessionManager.getSession(sessionID)
    if (!session) return
    const scopeID = Identifier.asScopeID(session.scope.id)
    const id = Identifier.asSessionID(sessionID)
    const infoKey = StoragePath.sessionInfo(scopeID, id)
    await prepareSessionMigrations({ scopeID, sessionID })
    for (;;) {
      const source = await Storage.snapshot(async () => {
        const [existing] = await Storage.readMany([infoKey])
        if (!existing) return
        const infos = await SessionHistory.modelMessageInfos({ sessionID })
        const messages = await Storage.queryKeys({ kind: "message", scopeID, sessionID })
        const keys = [
          infoKey,
          StoragePath.sessionDisplayState(scopeID, sessionID),
          StoragePath.sessionMessageOrderState(scopeID, id),
          ...messages,
          ...messages.map((key) => StoragePath.sessionDisplayPartsState(scopeID, sessionID, key[4])),
        ]
        return { infos, keys, revisions: await Storage.revisions(keys) }
      })
      if (!source) return
      const unchanged = async () => {
        const revisions = await Storage.revisions(source.keys)
        return revisions.every((revision, index) => revision === source.revisions[index])
      }
      const lastExchange: NonNullable<Info["lastExchange"]> = {}
      try {
        for (const info of source.infos.toReversed()) {
          if (lastExchange[info.role]) continue
          const records = await Storage.snapshot(async () =>
            Array.fromAsync(MessageV2.partRecords({ scopeID, sessionID, messageID: info.id })),
          )
          for (const record of records) {
            source.keys.push(record.key)
            source.revisions.push(record.revision)
          }
          const texts = records
            .filter(({ value }) => value.type === "text" && !MessageV2.isSystemPart(value))
            .sort((a, b) => (a.value.id > b.value.id ? 1 : -1))
          const text = await PartContent.prefix(texts, { maxLength: 200, separator: "\n" })
          if (text) lastExchange[info.role] = text
          if (lastExchange.user && lastExchange.assistant) break
        }
      } catch (error) {
        if (!(await unchanged())) continue
        throw error
      }
      const written = await Storage.transaction(async () => {
        if (!(await unchanged())) return false
        await SessionRecords.update(infoKey, (draft) => {
          draft.lastExchange = lastExchange
        })
        return true
      })
      if (written) return
    }
  }
}
