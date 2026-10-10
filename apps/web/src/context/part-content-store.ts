import type { Part, SessionPartContent } from "@ericsanchezok/synergy-sdk"

type Entry = {
  url: string
  scopeKey: string
  sessionID: string
  messageID: string
  partID: string
  part: string
  version: string
  bytes: number
}

type ContentKey = { url: string; scopeKey: string; partID: string; version: string }
type PendingRead = { controller: AbortController; promise: Promise<SessionPartContent>; readers: number }

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
  const pending = new Map<string, PendingRead>()
  const keyOf = (url: string, scopeKey: string, partID: string, version: string) =>
    `${url}\0${scopeKey}\0${partID}\0${version}`
  const trim = () => {
    for (const [key, entry] of entries) {
      if (bytes <= limit) break
      entries.delete(key)
      bytes -= entry.bytes
    }
  }
  const cache = {
    get bytes() {
      return bytes
    },
    size(): number {
      return entries.size
    },
    get(input: ContentKey): Part | undefined {
      const key = keyOf(input.url, input.scopeKey, input.partID, input.version)
      const entry = entries.get(key)
      if (!entry) return
      entries.delete(key)
      entries.set(key, entry)
      return JSON.parse(entry.part) as Part
    },
    put(input: ContentKey & { part: Part }): void {
      const key = keyOf(input.url, input.scopeKey, input.partID, input.version)
      const part = JSON.stringify(input.part)
      const snapshotBytes = part.length * 2
      const existing = entries.get(key)
      if (existing) {
        entries.set(key, { ...existing, part, bytes: snapshotBytes })
        bytes += snapshotBytes - existing.bytes
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
        part,
        bytes: snapshotBytes,
      })
      bytes += snapshotBytes
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
    read(
      input: ContentKey,
      load: (signal: AbortSignal) => Promise<SessionPartContent>,
      signal: AbortSignal,
    ): Promise<SessionPartContent> {
      if (signal.aborted) return Promise.reject(signal.reason)
      const remembered = cache.get(input)
      if (remembered) return Promise.resolve({ part: remembered, version: input.version })
      const key = keyOf(input.url, input.scopeKey, input.partID, input.version)
      let entry = pending.get(key)
      if (!entry) {
        const controller = new AbortController()
        const promise = Promise.resolve()
          .then(() => {
            controller.signal.throwIfAborted()
            return load(controller.signal)
          })
          .then((response) => {
            controller.signal.throwIfAborted()
            cache.put({ ...input, version: response.version, part: response.part })
            return response
          })
          .finally(() => {
            if (pending.get(key)?.promise === promise) pending.delete(key)
          })
        entry = { controller, promise, readers: 0 }
        pending.set(key, entry)
      }
      const retained = entry
      retained.readers++
      return new Promise((resolve, reject) => {
        let released = false
        const release = () => {
          if (released) return false
          released = true
          signal.removeEventListener("abort", abort)
          if (--retained.readers === 0 && pending.get(key) === retained) {
            pending.delete(key)
            retained.controller.abort()
          }
          return true
        }
        const abort = () => {
          if (release()) reject(signal.reason)
        }
        signal.addEventListener("abort", abort, { once: true })
        retained.promise.then(
          (response) => {
            if (release())
              resolve({ part: JSON.parse(JSON.stringify(response.part)) as Part, version: response.version })
          },
          (error) => {
            if (release()) reject(error)
          },
        )
        if (signal.aborted) abort()
      })
    },
    clear(): void {
      entries.clear()
      bytes = 0
    },
  }
  return cache
}

export type PartContentStore = ReturnType<typeof createPartContentStore>
