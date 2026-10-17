export function createResourcePreviewCache<T>() {
  const entries = new Map<
    string,
    {
      controller: AbortController
      promise: Promise<T>
      readers: number
      settled: boolean
      expires: number
    }
  >()
  const remove = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    entry.controller.abort(new DOMException("Reference preview closed", "AbortError"))
  }
  return {
    clear() {
      for (const key of entries.keys()) remove(key)
    },
    read(key: string, load: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(signal.reason)
      let entry = entries.get(key)
      if (entry?.settled && entry.expires <= Date.now()) {
        remove(key)
        entry = undefined
      }
      if (!entry) {
        const controller = new AbortController()
        const promise = new Promise<T>((resolve) => resolve(load(controller.signal)))
        entry = { controller, promise, readers: 0, settled: false, expires: Infinity }
        const created = entry
        entries.set(key, created)
        void promise.then(
          () => {
            created.settled = true
            created.expires = Date.now() + 30_000
            for (const [cachedKey, cached] of entries) {
              if (entries.size <= 64) break
              if (cached.settled && !cached.readers) remove(cachedKey)
            }
          },
          () => {
            created.settled = true
            if (entries.get(key) === created) entries.delete(key)
          },
        )
      }
      const current = entry
      current.readers++
      return new Promise<T>((resolve, reject) => {
        let complete = false
        const finish = (work: () => void) => {
          if (complete) return
          complete = true
          signal?.removeEventListener("abort", abort)
          current.controller.signal.removeEventListener("abort", invalidate)
          current.readers--
          work()
          if (!current.readers && !current.settled && entries.get(key) === current) remove(key)
        }
        const abort = () => finish(() => reject(signal?.reason))
        const invalidate = () => finish(() => reject(current.controller.signal.reason))
        signal?.addEventListener("abort", abort, { once: true })
        current.controller.signal.addEventListener("abort", invalidate, { once: true })
        if (current.controller.signal.aborted) invalidate()
        current.promise.then(
          (value) => finish(() => resolve(value)),
          (error) => finish(() => reject(error)),
        )
      })
    },
  }
}
