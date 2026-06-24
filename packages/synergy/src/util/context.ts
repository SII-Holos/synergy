import { AsyncLocalStorage } from "async_hooks"

export namespace Context {
  export class NotFound extends Error {
    constructor(public override readonly name: string) {
      super(`No context found for ${name}`)
    }
  }

  interface Store<T> {
    value: T
    overlay?: T
  }

  export function create<T>(name: string) {
    const storage = new AsyncLocalStorage<Store<T>>()
    return {
      use() {
        const store = storage.getStore()
        if (!store) {
          throw new NotFound(name)
        }
        return store.overlay ?? store.value
      },
      tryUse() {
        const store = storage.getStore()
        if (!store) return undefined
        return store.overlay ?? store.value
      },
      provide<R>(value: T, fn: () => R) {
        return storage.run({ value }, fn)
      },
      update(overlay: T) {
        const store = storage.getStore()
        if (!store) {
          throw new NotFound(name)
        }
        store.overlay = overlay
      },
    }
  }
}
