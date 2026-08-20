const timeFormat = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" })

const MINUTE_MS = 60_000
const BUCKET_CACHE_LIMIT = 64

// Frozen message-row timestamps: the label only depends on which minute the
// message was created in, so format once per minute bucket and reuse the
// string. Streaming deltas replace message objects and re-run the owning
// memos; the cache turns those re-runs into map lookups instead of fresh
// Intl formatting work.
const bucketCache = new Map<number, string>()

export function messageCreatedTime(ms: number | undefined): string | undefined {
  if (ms == null) return undefined
  const bucket = Math.floor(ms / MINUTE_MS)
  const cached = bucketCache.get(bucket)
  if (cached !== undefined) return cached
  const result = timeFormat.format(new Date(ms))
  if (bucketCache.size >= BUCKET_CACHE_LIMIT) bucketCache.clear()
  bucketCache.set(bucket, result)
  return result
}
