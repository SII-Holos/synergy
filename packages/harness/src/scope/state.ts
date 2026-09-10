import { AsyncLocalStorage } from "node:async_hooks"
import { Log } from "../util/log"

export namespace State {
  interface Entry {
    cleanup?: Promise<void>
    state: any
    dispose?: (state: any) => Promise<void>
  }

  const log = Log.create({ service: "state" })
  const recordsByKey = new Map<string, Map<any, Entry>>()

  function release(entry: Entry, key: string) {
    entry.cleanup ??= Promise.resolve(entry.state)
      .then((state) => entry.dispose?.(state))
      .catch((error) => {
        log.error("Error while disposing state:", { error, key })
      })
    return entry.cleanup
  }

  export function create<S>(root: () => string, init: () => S, dispose?: (state: Awaited<S>) => Promise<void>) {
    const accessor = (() => {
      const key = root()
      let entries = recordsByKey.get(key)
      if (!entries) {
        entries = new Map<string, Entry>()
        recordsByKey.set(key, entries)
      }
      const exists = entries.get(init)
      if (exists) return exists.state as S
      const state = init()
      entries.set(init, {
        state,
        dispose: dispose ? AsyncLocalStorage.bind(dispose) : undefined,
      })
      // Auto-evict on rejection so transient failures don't become permanent.
      // The caller still sees the rejection — this only prevents it from being
      // cached forever, allowing the next access to retry init().
      if (state != null && typeof (state as any).catch === "function") {
        ;(state as any).catch(() => {
          const current = recordsByKey.get(key)
          if (current?.get(init)?.state === state) {
            current.delete(init)
            if (current.size === 0) recordsByKey.delete(key)
            log.warn("evicted failed state entry", { key })
          }
        })
      }
      return state
    }) as (() => S) & { reset: () => Promise<void>; resetAll: () => Promise<void>; peek: () => S | undefined }

    accessor.reset = async () => {
      const key = root()
      const entries = recordsByKey.get(key)
      if (!entries) return
      const entry = entries.get(init)
      if (!entry) return
      await release(entry, key)
      if (entries.get(init) === entry) entries.delete(init)
      log.info("state entry reset", { key })
    }

    accessor.peek = () => {
      const key = root()
      const entries = recordsByKey.get(key)
      if (!entries) return undefined
      const entry = entries.get(init)
      if (!entry) return undefined
      return entry.state as S
    }

    accessor.resetAll = async () => {
      const tasks: Promise<void>[] = []
      for (const [key, entries] of recordsByKey) {
        const entry = entries.get(init)
        if (!entry) continue
        tasks.push(
          release(entry, key).then(() => {
            if (entries.get(init) === entry) entries.delete(init)
            if (entries.size === 0) recordsByKey.delete(key)
          }),
        )
      }
      await Promise.all(tasks)
      if (tasks.length > 0) log.info("state entry reset across all scopes", { count: tasks.length })
    }

    return accessor
  }

  export async function dispose(key: string) {
    const entries = recordsByKey.get(key)
    if (!entries) return

    log.info("waiting for state disposal to complete", { key })

    let disposalFinished = false

    setTimeout(() => {
      if (!disposalFinished) {
        log.warn(
          "state disposal is taking an unusually long time - if it does not complete in a reasonable time, please report this as a bug",
          { key },
        )
      }
    }, 10000).unref()

    const tasks: Promise<void>[] = []
    for (const [init, entry] of entries) {
      tasks.push(
        release(entry, key).then(() => {
          if (entries.get(init) === entry) entries.delete(init)
        }),
      )
    }
    await Promise.all(tasks)
    if (entries.size === 0 && recordsByKey.get(key) === entries) recordsByKey.delete(key)
    disposalFinished = true
    log.info("state disposal completed", { key })
  }

  export async function disposeAll() {
    const keys = [...recordsByKey.keys()]
    for (const key of keys) {
      await dispose(key)
    }
  }
}
