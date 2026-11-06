/**
 * Debounced, budgeted scheduler for message-window repair reloads.
 *
 * When an authoritative part checkpoint or removal arrives for a message that
 * is not in the loaded window, the event is dropped and the message is marked
 * as requiring a newer snapshot (`SessionPartSnapshotFreshness`). While the
 * user stays on the session nothing re-fetches, so the dropped part stays
 * missing until a manual refresh. This scheduler turns that "requires
 * snapshot" signal into one deferred message-page reload per session,
 * rate-limited so a pathological stream of orphan events cannot loop.
 */
export type PartRepairSchedulerOptions = {
  delayMs?: number
  windowMs?: number
  maxAttempts?: number
  now?: () => number
  schedule?: (fn: () => void, ms: number) => () => void
}

export type PartRepairScheduler = {
  request(scopeKey: string, sessionID: string): void
  clear(scopeKey: string, sessionID: string): void
  clearScope(scopeKey: string): void
  dispose(): void
}

const DEFAULT_DELAY_MS = 2000
const DEFAULT_WINDOW_MS = 60_000
const DEFAULT_MAX_ATTEMPTS = 3

type BucketState = {
  cancel?: () => void
  attempts: number[]
}

export function createPartRepairScheduler(
  options: PartRepairSchedulerOptions,
  repair: (scopeKey: string, sessionID: string) => void,
): PartRepairScheduler {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const now = options.now ?? (() => Date.now())
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    })

  const bucketKey = (scopeKey: string, sessionID: string) => `${scopeKey}\n${sessionID}`
  const buckets = new Map<string, BucketState>()

  const state = (key: string): BucketState => {
    const existing = buckets.get(key)
    if (existing) return existing
    const created: BucketState = { attempts: [] }
    buckets.set(key, created)
    return created
  }

  const recentAttempts = (bucket: BucketState) => {
    const threshold = now() - windowMs
    bucket.attempts = bucket.attempts.filter((at) => at >= threshold)
    return bucket.attempts.length
  }

  return {
    request(scopeKey, sessionID) {
      const key = bucketKey(scopeKey, sessionID)
      const bucket = state(key)
      if (bucket.cancel) return
      if (recentAttempts(bucket) >= maxAttempts) return
      bucket.cancel = schedule(() => {
        bucket.cancel = undefined
        bucket.attempts.push(now())
        repair(scopeKey, sessionID)
      }, delayMs)
    },
    clear(scopeKey, sessionID) {
      const key = bucketKey(scopeKey, sessionID)
      const bucket = buckets.get(key)
      if (!bucket) return
      bucket.cancel?.()
      buckets.delete(key)
    },
    clearScope(scopeKey) {
      const prefix = `${scopeKey}\n`
      for (const [key, bucket] of buckets) {
        if (!key.startsWith(prefix)) continue
        bucket.cancel?.()
        buckets.delete(key)
      }
    },
    dispose() {
      for (const bucket of buckets.values()) bucket.cancel?.()
      buckets.clear()
    },
  }
}
