type Entry = {
  controller: AbortController
  promise: Promise<unknown>
  consumers: number
  settled: boolean
  expires: number
}

export function createSharedRequests(options: { now?: () => number; capacity?: number } = {}) {
  const entries = new Map<string, Entry>()
  const now = options.now ?? Date.now
  const capacity = options.capacity ?? 256
  return {
    invalidate(prefix: string) {
      for (const [key, entry] of entries) {
        if (!key.startsWith(prefix)) continue
        entries.delete(key)
        if (!entry.consumers) entry.controller.abort()
      }
    },
    request<T>(
      key: string,
      load: (signal: AbortSignal) => Promise<T>,
      input: { signal?: AbortSignal; ttlMs?: number } = {},
    ): Promise<T> {
      if (input.signal?.aborted) return Promise.reject(input.signal.reason)
      let entry = entries.get(key)
      if (entry?.settled && entry.expires <= now()) {
        entries.delete(key)
        entry = undefined
      }
      if (!entry) {
        const controller = new AbortController()
        const created: Entry = {
          controller,
          promise: Promise.resolve(),
          consumers: 0,
          settled: false,
          expires: Infinity,
        }
        try {
          created.promise = load(controller.signal)
        } catch (error) {
          created.promise = Promise.reject(error)
        }
        entry = created
        entries.set(key, entry)
        created.promise = created.promise.then(
          (value) => {
            created.settled = true
            created.expires = now() + (input.ttlMs ?? 5_000)
            if (entries.get(key) === created) {
              entries.delete(key)
              entries.set(key, created)
              for (const [oldKey, old] of entries) {
                if (entries.size <= capacity) break
                if (old.settled && !old.consumers) entries.delete(oldKey)
              }
            }
            return value
          },
          (error) => {
            created.settled = true
            if (entries.get(key) === created) entries.delete(key)
            throw error
          },
        )
        void created.promise.catch(() => {})
      }
      const shared = entry
      shared.consumers++
      return new Promise<T>((resolve, reject) => {
        let released = false
        const release = () => {
          if (released) return false
          released = true
          input.signal?.removeEventListener("abort", abort)
          shared.consumers--
          if (!shared.settled && !shared.consumers) {
            if (entries.get(key) === shared) entries.delete(key)
            shared.controller.abort()
          }
          return true
        }
        const abort = () => {
          if (release()) reject(input.signal?.reason)
        }
        input.signal?.addEventListener("abort", abort, { once: true })
        shared.promise.then(
          (value) => {
            if (release()) resolve(value as T)
          },
          (error) => {
            if (release()) reject(error)
          },
        )
        if (input.signal?.aborted) abort()
      })
    },
  }
}

export const sharedRequests = createSharedRequests()
