import { Context } from "../../util/context"
import type { RolloutSchema } from "./schema"

export namespace RolloutContext {
  export type Identity = { owner: RolloutSchema.Owner; runID: string; callID?: string; signal?: AbortSignal }
  const storage = Context.create<Identity>("rollout")
  export function current() {
    return storage.tryUse()
  }
  export function provide<T>(identity: Identity, action: () => T): T {
    return storage.provide(identity, action)
  }
}
