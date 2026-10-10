import { RuntimeContext } from "../lifecycle/context"
import type { StoreTransaction } from "./transactional-store"

export namespace StorageMutationGuard {
  export type Guard = (tx: StoreTransaction, keys: readonly string[][], tree: boolean) => Promise<void>
  const state = RuntimeContext.state(() => new Map<string, Guard>())

  export function register(id: string, guard: Guard) {
    RuntimeContext.assertCompositionOpen("storage mutation guard")
    if (state().has(id)) throw new Error(`Storage mutation guard ${id} is already registered`)
    state().set(id, guard)
  }

  export async function assert(tx: StoreTransaction, keys: readonly string[][], tree: boolean) {
    for (const guard of state().values()) await guard(tx, keys, tree)
  }
}
