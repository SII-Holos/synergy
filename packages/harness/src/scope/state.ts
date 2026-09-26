import { RuntimeContext } from "../lifecycle/context"
import { AsyncLocalStorage } from "node:async_hooks"
import { Log } from "../util/log"

export namespace State {
  interface Entry {
    cleanup?: Promise<void>
    state: unknown
    dispose?: () => Promise<void>
  }

  const log = Log.create({ service: "state" })
  const runtimeState = RuntimeContext.state(() => ({
    recordsByKey: new Map<string, Map<() => unknown, Entry>>(),
  }))

  function release(entry: Entry, key: string) {
    entry.cleanup ??= Promise.resolve()
      .then(() => entry.dispose?.())
      .catch((error) => {
        log.error("Error while disposing state", { error, key })
        throw error
      })
    return entry.cleanup
  }

  export function create<S>(root: () => string, init: () => S, dispose?: (state: Awaited<S>) => Promise<void>) {
    const accessor = (() => {
      const instanceState = runtimeState()

      const key = root()
      let entries = instanceState.recordsByKey.get(key)
      if (!entries) {
        entries = new Map<() => unknown, Entry>()
        instanceState.recordsByKey.set(key, entries)
      }
      const exists = entries.get(init)
      if (exists) return exists.state as S
      const state = init()
      entries.set(init, {
        state,
        dispose: dispose ? AsyncLocalStorage.bind(async () => dispose(await state)) : undefined,
      })
      if (state instanceof Promise) {
        void state.catch(() => {
          const current = instanceState.recordsByKey.get(key)
          if (current?.get(init)?.state !== state) return
          current.delete(init)
          if (current.size === 0) instanceState.recordsByKey.delete(key)
          log.warn("evicted failed state entry", { key })
        })
      }
      return state
    }) as (() => S) & { reset: () => Promise<void>; resetAll: () => Promise<void>; peek: () => S | undefined }

    accessor.reset = async () => {
      const instanceState = runtimeState()

      const key = root()
      const entries = instanceState.recordsByKey.get(key)
      if (!entries) return
      const entry = entries.get(init)
      if (!entry) return
      try {
        await release(entry, key)
      } finally {
        if (entries.get(init) === entry) entries.delete(init)
        if (entries.size === 0 && instanceState.recordsByKey.get(key) === entries)
          instanceState.recordsByKey.delete(key)
      }
      log.info("state entry reset", { key })
    }

    accessor.peek = () => {
      const instanceState = runtimeState()

      const key = root()
      const entries = instanceState.recordsByKey.get(key)
      if (!entries) return undefined
      const entry = entries.get(init)
      if (!entry) return undefined
      return entry.state as S
    }

    accessor.resetAll = async () => {
      const instanceState = runtimeState()

      const tasks: Promise<void>[] = []
      for (const [key, entries] of instanceState.recordsByKey) {
        const entry = entries.get(init)
        if (!entry) continue
        tasks.push(
          release(entry, key).finally(() => {
            if (entries.get(init) === entry) entries.delete(init)
            if (entries.size === 0 && instanceState.recordsByKey.get(key) === entries)
              instanceState.recordsByKey.delete(key)
          }),
        )
      }
      await settle(tasks)
      if (tasks.length > 0) log.info("state entry reset across all scopes", { count: tasks.length })
    }

    return accessor
  }

  export async function dispose(key: string) {
    const instanceState = runtimeState()

    const entries = instanceState.recordsByKey.get(key)
    if (!entries) return

    log.info("waiting for state disposal to complete", { key })

    const warning = setTimeout(() => {
      log.warn("state disposal is taking an unusually long time", { key })
    }, 10000)
    warning.unref()

    const tasks: Promise<void>[] = []
    for (const [init, entry] of entries) {
      tasks.push(
        release(entry, key).finally(() => {
          if (entries.get(init) === entry) entries.delete(init)
        }),
      )
    }
    try {
      await settle(tasks)
      log.info("state disposal completed", { key })
    } finally {
      clearTimeout(warning)
      if (entries.size === 0 && instanceState.recordsByKey.get(key) === entries) instanceState.recordsByKey.delete(key)
    }
  }

  async function settle(tasks: Promise<void>[]) {
    const results = await Promise.allSettled(tasks)
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, "Scope resources could not be released")
  }

  export async function disposeAll() {
    const instanceState = runtimeState()

    const keys = [...instanceState.recordsByKey.keys()]
    await settle(keys.map(dispose))
  }
}
