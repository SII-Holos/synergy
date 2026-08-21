const MINUTE_MS = 60_000
const BUCKET_CACHE_LIMIT = 64
const LOCALE_CACHE_LIMIT = 8

type LocaleTimeBucket = {
  format: Intl.DateTimeFormat
  cache: Map<number, string>
}

// Per-locale formatter + minute-bucket cache. Keying by the active Lingui
// locale keeps the frozen label correct across locale switches (hour cycle,
// day-period conventions) instead of binding to the locale resolved when the
// module first loaded. An empty key means the runtime default locale.
const bucketsByLocale = new Map<string, LocaleTimeBucket>()

function bucketFor(locale: string | undefined): LocaleTimeBucket {
  const key = locale ?? ""
  const existing = bucketsByLocale.get(key)
  if (existing) return existing
  if (bucketsByLocale.size >= LOCALE_CACHE_LIMIT) bucketsByLocale.clear()
  const created: LocaleTimeBucket = {
    format: new Intl.DateTimeFormat(locale ? [locale] : [], { hour: "2-digit", minute: "2-digit" }),
    cache: new Map(),
  }
  bucketsByLocale.set(key, created)
  return created
}

// Frozen message-row timestamps: the label only depends on which minute the
// message was created in, so format once per minute bucket and reuse the
// string. Streaming deltas replace message objects and re-run the owning
// memos; the cache turns those re-runs into map lookups instead of fresh
// Intl formatting work.
export function messageCreatedTime(ms: number | undefined, locale?: string): string | undefined {
  if (ms == null) return undefined
  const bucket = bucketFor(locale)
  const minute = Math.floor(ms / MINUTE_MS)
  const cached = bucket.cache.get(minute)
  if (cached !== undefined) return cached
  const result = bucket.format.format(new Date(ms))
  if (bucket.cache.size >= BUCKET_CACHE_LIMIT) bucket.cache.clear()
  bucket.cache.set(minute, result)
  return result
}
