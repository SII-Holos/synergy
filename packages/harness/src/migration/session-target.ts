import { AsyncLocalStorage } from "node:async_hooks"
import { Storage } from "../storage/storage"
import type { RecordQuery } from "../storage/transactional-store"

type Owner = { scopeID: string; sessionID: string }
const target = new AsyncLocalStorage<Owner>()

export namespace SessionMigrationTarget {
  export function provide<T>(owner: Owner, body: () => Promise<T>) {
    return target.run(owner, body)
  }
  export function scopes() {
    const owner = target.getStore()
    return owner ? Promise.resolve([owner.scopeID]) : Storage.scan(["sessions"])
  }
  export function sessions(scopeID: string) {
    const owner = target.getStore()
    return owner
      ? Promise.resolve(owner.scopeID === scopeID ? [owner.sessionID] : [])
      : Storage.scan(["sessions", scopeID])
  }
  export function records<T>(query: RecordQuery) {
    return Storage.records<T>({ ...query, ...target.getStore() })
  }
}
