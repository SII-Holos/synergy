import { AsyncLocalStorage } from "node:async_hooks"
import type { Storage } from "../storage/storage"
import { assertIsolatedTestHome } from "../global/test-home-guard"
import path from "node:path"

export interface RuntimeHost {
  readonly home: string
  readonly root: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly workspaceLocation?: import("../workspace/location").WorkspaceLocationSource
}

export namespace RuntimeContext {
  const context = new AsyncLocalStorage<Instance>()
  // Domain context definitions are shared; detached native callbacks must leave every domain's active value.
  const localContexts: Array<Pick<AsyncLocalStorage<unknown>, "exit">> = []
  const states = new WeakMap<Instance, Map<symbol, unknown>>()
  const sealedCompositions = new WeakSet<Instance>()
  const transactionOwner = new AsyncLocalStorage<Instance>()

  export interface Instance {
    readonly host: RuntimeHost
    storage?: Storage.Handle
    dispose(): void
    run<T>(body: () => T): T
    bind<A extends unknown[], R>(body: (...args: A) => R): (...args: A) => R
  }

  export function create(host: RuntimeHost): Instance {
    if (!path.isAbsolute(host.home) || !path.isAbsolute(host.root)) throw new Error("Runtime paths must be absolute")
    assertIsolatedTestHome(host.root, Bun.main, process.argv, host.env)
    const instance: Instance = {
      host: Object.freeze({ ...host, env: Object.freeze({ ...host.env }) }),
      dispose() {
        instance.storage = undefined
        states.delete(instance)
      },
      run(body) {
        if (!states.has(instance)) throw new Error("Runtime is closed")
        const owner = transactionOwner.getStore()
        if (owner && owner !== instance) throw new Error("Cannot switch runtimes inside a storage transaction")
        return context.run(instance, body)
      },
      bind:
        (body) =>
        (...args) =>
          instance.run(() => body(...args)),
    }
    states.set(instance, new Map())
    return instance
  }

  export function exit<T>(body: () => T): T {
    const leave = (index: number): T =>
      index === localContexts.length ? context.exit(body) : localContexts[index]!.exit(() => leave(index + 1))
    return leave(0)
  }

  export function createAsyncContext<T>() {
    const storage = new AsyncLocalStorage<T>()
    localContexts.push(storage)
    return storage
  }

  export function current(): Instance {
    const instance = context.getStore()
    if (!instance) throw new Error("No runtime context; enter through an explicit Runtime Handle")
    if (!states.has(instance)) throw new Error("Runtime is closed")
    return instance
  }

  export function tryCurrent(): Instance | undefined {
    const instance = context.getStore()
    return instance && states.has(instance) ? instance : undefined
  }

  export function sealComposition() {
    sealedCompositions.add(current())
  }

  export function assertCompositionOpen(name: string) {
    if (sealedCompositions.has(current())) throw new Error(`Register ${name} before opening the Runtime`)
  }

  export function transaction<T>(body: () => T): T {
    return transactionOwner.run(current(), body)
  }

  export function state<T>(create: () => T): () => T {
    const key = Symbol()
    return () => {
      const values = states.get(current())!
      if (!values.has(key)) values.set(key, create())
      return values.get(key) as T
    }
  }
}
