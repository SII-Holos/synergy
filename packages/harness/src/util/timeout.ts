export interface WithTimeoutOptions {
  signal?: AbortSignal
  message?: string
}

export function withTimeout<T>(promise: Promise<T>, ms: number | undefined, opts?: WithTimeoutOptions): Promise<T> {
  if (ms === undefined || ms <= 0) return promise

  let timer: ReturnType<typeof setTimeout> | undefined

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (opts?.signal && !opts.signal.aborted) {
        opts.signal.dispatchEvent(new Event("abort"))
      }
      reject(new Error(opts?.message ?? `Operation timed out after ${ms}ms`))
    }, ms)
  })

  const race = Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })

  if (opts?.signal) {
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer)
    }
    opts.signal.addEventListener("abort", onAbort, { once: true })
    race.finally(() => opts.signal!.removeEventListener("abort", onAbort))
  }

  return race
}
