import type { Part, SessionPartSummary } from "@ericsanchezok/synergy-sdk"

type Entry = {
  url: string
  scopeKey: string
  sessionID: string
  messageID: string
  partID: string
  part: Part
  version: string
  bytes: number
}

/**
 * Version-keyed conversation content store for the Web client. A part's
 * `content.version` is a content hash, so identical versions are byte-identical
 * — the cache needs no invalidation beyond "a different version appears" and
 * survives session switches, content-budget LRU evictions, and materializer
 * dispose, closing the repeated "same content refetched on every navigation"
 * cost the per-part budget entries created on their own.
 */
export function createPartContentStore(limit = 64 * 1024 * 1024) {
  let bytes = 0
  const entries = new Map<string, Entry>()
  // In-flight versioned reads shared by every consumer (viewport prefetch,
  // part materializer, future readers): a content version is a hash, so two
  // concurrent callers for the same version can always share one fetch.
  // Entries are removed when the underlying fetch settles, so a retry starts
  // a fresh read instead of inheriting a rejected result.
  const inflight = new Map<string, Promise<{ part: Part; version: string }>>()
  const keyOf = (url: string, scopeKey: string, partID: string, version: string) =>
    `${url}\0${scopeKey}\0${partID}\0${version}`
  const trim = () => {
    for (const [key, entry] of entries) {
      if (bytes <= limit) break
      entries.delete(key)
      bytes -= entry.bytes
    }
  }
  const put = (input: {
    url: string
    scopeKey: string
    partID: string
    version: string
    part: Part
    bytes: number
  }): void => {
    const key = keyOf(input.url, input.scopeKey, input.partID, input.version)
    const existing = entries.get(key)
    if (existing) {
      entries.set(key, { ...existing, part: input.part, bytes: input.bytes })
      bytes -= existing.bytes - input.bytes
      trim()
      return
    }
    entries.set(key, {
      url: input.url,
      scopeKey: input.scopeKey,
      sessionID: input.part.sessionID,
      messageID: input.part.messageID,
      partID: input.partID,
      version: input.version,
      part: input.part,
      bytes: input.bytes,
    })
    bytes += input.bytes
    trim()
  }
  return {
    get bytes() {
      return bytes
    },
    size(): number {
      return entries.size
    },
    get(input: { url: string; scopeKey: string; partID: string; version: string }): Part | undefined {
      const key = keyOf(input.url, input.scopeKey, input.partID, input.version)
      const entry = entries.get(key)
      if (!entry) return
      entries.delete(key)
      entries.set(key, entry)
      return entry.part
    },
    readThrough(input: {
      url: string
      scopeKey: string
      partID: string
      version: string
      bytes: number
      read: () => Promise<{ part: Part; version: string }>
    }): Promise<{ part: Part; version: string }> {
      const key = keyOf(input.url, input.scopeKey, input.partID, input.version)
      const hit = entries.get(key)
      if (hit) {
        entries.delete(key)
        entries.set(key, hit)
        return Promise.resolve({ part: hit.part, version: hit.version })
      }
      const shared = inflight.get(key) ?? inflight.set(key, input.read()).get(key)!
      return shared
        .then((result) => {
          if (result.version === input.version) {
            put({
              url: input.url,
              scopeKey: input.scopeKey,
              partID: input.partID,
              version: result.version,
              part: result.part,
              bytes: input.bytes,
            })
          }
          return result
        })
        .finally(() => {
          if (inflight.get(key) === shared) inflight.delete(key)
        })
    },
    put,
    invalidate(messageID: string, partID?: string): void {
      for (const [key, entry] of entries) {
        if (entry.messageID === messageID && (!partID || entry.partID === partID)) {
          entries.delete(key)
          bytes -= entry.bytes
        }
      }
    },
    clear(): void {
      entries.clear()
      bytes = 0
      inflight.clear()
    },
  }
}

export type PartContentStore = ReturnType<typeof createPartContentStore>
