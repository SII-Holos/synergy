import { AsyncLocalStorage } from "node:async_hooks"
import type { RolloutSchema } from "./schema"

export namespace RolloutContext {
  export type Identity = { owner: RolloutSchema.Owner; runID: string; callID?: string; signal?: AbortSignal }
  const storage = new AsyncLocalStorage<Identity>()
  export function current() {
    return storage.getStore()
  }
  export function provide<T>(identity: Identity, action: () => T): T {
    return storage.run(identity, action)
  }
}
