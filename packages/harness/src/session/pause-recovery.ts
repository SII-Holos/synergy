import { Storage } from "../storage/storage"

export namespace SessionPauseRecovery {
  export type Owner = { scopeID: string; sessionID: string }
  type Pending = { revision: string }
  const key = (owner: Owner) => ["sessions", owner.scopeID, owner.sessionID, "pause_recovery_pending"]

  const deferredKey = (owner: Owner) => ["sessions", owner.scopeID, owner.sessionID, "pause_recovery_deferred"]

  export async function defer(owner: Owner) {
    await Storage.write(deferredKey(owner), { version: 1 })
  }

  export async function request(owner: Owner) {
    return Storage.transaction(async () => {
      const pending = await revision(owner)
      if (pending) return pending
      const [deferred] = await Storage.readMany([deferredKey(owner)])
      if (!deferred) return
      await mark(owner)
      return revision(owner)
    })
  }

  export async function mark(owner: Owner) {
    await Storage.write(key(owner), { revision: crypto.randomUUID() })
  }

  export async function revision(owner: Owner) {
    const [pending] = await Storage.readMany<Pending>([key(owner)])
    return pending?.revision
  }

  export async function complete(owner: Owner, revision: string) {
    await Storage.transaction(async () => {
      const [current] = await Storage.readMany<Pending>([key(owner)])
      if (current?.revision !== revision) return
      await Storage.remove(key(owner))
      await Storage.remove(deferredKey(owner))
    })
  }

  export async function* owners(scopeID?: string): AsyncGenerator<Owner> {
    for await (const record of Storage.records<Pending>({ kind: "pause_recovery_pending", scopeID }))
      yield { scopeID: record.key[1]!, sessionID: record.key[2]! }
  }
}
