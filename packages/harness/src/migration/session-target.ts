import { Context } from "../util/context"
import { UpgradeWork } from "../storage/upgrade-work"
import { Storage } from "../storage/storage"
import type { RecordQuery } from "../storage/transactional-store"

type Owner = { scopeID: string; sessionID: string }
const target = Context.create<Owner>("migration.session-target")

export namespace SessionMigrationTarget {
  export function provide<T>(owner: Owner, body: () => Promise<T>) {
    return target.provide(owner, body)
  }
  export function scopes() {
    const owner = target.tryUse()
    return owner ? Promise.resolve([owner.scopeID]) : Storage.scan(["sessions"])
  }
  export function sessions(scopeID: string) {
    const owner = target.tryUse()
    return owner
      ? Promise.resolve(owner.scopeID === scopeID ? [owner.sessionID] : [])
      : Storage.scan(["sessions", scopeID])
  }
  export async function* records<T>(query: RecordQuery) {
    for await (const record of Storage.records<T>({ ...query, ...target.tryUse() })) {
      await UpgradeWork.checkpoint()
      yield record
    }
  }
}
