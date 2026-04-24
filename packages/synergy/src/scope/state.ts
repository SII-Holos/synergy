import { Log } from "@/util/log"

export namespace State {
  interface Entry {
    state: any
    dispose?: (state: any) => Promise<void>
  }

  const log = Log.create({ service: "state" })
  const recordsByKey = new Map<string, Map<any, Entry>>()

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
        dispose,
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
      if (entry.dispose) {
        await Promise.resolve(entry.state)
          .then((state) => entry.dispose!(state))
          .catch((error) => {
            log.error("Error while resetting state:", { error, key })
          })
      }
      entries.delete(init)
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
        if (entry.dispose) {
          tasks.push(
            Promise.resolve(entry.state)
              .then((state) => entry.dispose!(state))
              .catch((error) => {
                log.error("Error while resetting state across scopes:", { error, key })
              }),
          )
        }
        entries.delete(init)
        if (entries.size === 0) recordsByKey.delete(key)
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
    for (const entry of entries.values()) {
      if (!entry.dispose) continue

      const task = Promise.resolve(entry.state)
        .then((state) => entry.dispose!(state))
        .catch((error) => {
          log.error("Error while disposing state:", { error, key })
        })

      tasks.push(task)
    }
    entries.clear()
    await Promise.all(tasks)
    disposalFinished = true
    log.info("state disposal completed", { key })
  }
}
