import { RuntimeContext } from "../lifecycle/context"

export namespace Context {
  export class NotFound extends Error {
    constructor(public override readonly name: string) {
      super(`No context found for ${name}`)
    }
  }

  interface Store<T> {
    value: T
    owner?: RuntimeContext.Instance
    overlay?: T
  }

  export function create<T>(name: string) {
    const storage = RuntimeContext.createAsyncContext<Store<T>>()
    return {
      use() {
        const store = storage.getStore()
        if (!store || store.owner !== RuntimeContext.tryCurrent()) {
          throw new NotFound(name)
        }
        return "overlay" in store ? store.overlay! : store.value
      },
      tryUse() {
        const store = storage.getStore()
        if (!store || store.owner !== RuntimeContext.tryCurrent()) return undefined
        return "overlay" in store ? store.overlay! : store.value
      },
      provide<R>(value: T, fn: () => R) {
        return storage.run({ value, owner: RuntimeContext.tryCurrent() }, fn)
      },
      update(overlay: T) {
        const store = storage.getStore()
        if (!store || store.owner !== RuntimeContext.tryCurrent()) {
          throw new NotFound(name)
        }
        store.overlay = overlay
      },
    }
  }
}
