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
  const keyOf = (url: string, scopeKey: string, partID: string, version: string) =>
    `${url}\0${scopeKey}\0${partID}\0${version}`
  const trim = () => {
    for (const [key, entry] of entries) {
      if (bytes <= limit) break
      entries.delete(key)
      bytes -= entry.bytes
    }
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
    put(input: { url: string; scopeKey: string; partID: string; version: string; part: Part; bytes: number }): void {
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
    },
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
    },
  }
}

export type PartContentStore = ReturnType<typeof createPartContentStore>
