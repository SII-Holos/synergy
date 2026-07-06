import type { MessageV2 } from "./message-v2"

// Loop-scoped in-memory session message cache (issue #350 D2).
//
// The invoke loop re-reads the entire session history from disk on every step
// (every tool call) to assemble the model prompt — O(messages × parts) file
// reads per step, thousands of reads for a long session (#350 H2). This cache
// holds the assembled list in memory and is maintained by the loop's own
// writes, so subsequent steps read from memory.
//
// Correctness rests on the #281 single-active-loop invariant (I1): the cache is
// trusted ONLY while a loop actively owns the session, during which that loop is
// the sole writer. Every message/part write in that window flows through
// Session.updatePart / updateMessage (compaction and summary included), which
// maintain the cache here; anything structural (removal, session delete)
// invalidates it; and the loop drops the whole entry on exit. Any uncertainty
// falls back to a fresh disk read — the cache is an accelerator, never the
// source of truth (disk remains authoritative for recovery, R3).
//
// Stored value: the raw, pre-`deriveSemantics` list ordered oldest→newest — the
// exact shape produced by the disk read in SessionHistory.rawMessages, so
// callers get identical results whether served from cache or disk.
//
// Maintenance is IMMUTABLE: arrays are copied on write, never mutated in place.
// A WithParts[] already handed to a caller (which then derives/copies it) stays
// a valid snapshot even as later writes advance the cache.
export namespace SessionMessageCache {
  const active = new Set<string>()
  const cache = new Map<string, MessageV2.WithParts[]>()

  /** Begin the single-writer window for a session (loop start). */
  export function enable(sessionID: string) {
    active.add(sessionID)
  }

  /** End the window and drop the entry (loop exit). */
  export function disable(sessionID: string) {
    active.delete(sessionID)
    cache.delete(sessionID)
  }

  /** Drop the cached list but keep the window open; the next read repopulates. */
  export function invalidate(sessionID: string) {
    cache.delete(sessionID)
  }

  export function isActive(sessionID: string) {
    return active.has(sessionID)
  }

  /** Cached raw list, or undefined when the window is closed or unpopulated. */
  export function get(sessionID: string): MessageV2.WithParts[] | undefined {
    return active.has(sessionID) ? cache.get(sessionID) : undefined
  }

  /** Seed the cache from a fresh disk read (no-op outside the window). */
  export function set(sessionID: string, messages: MessageV2.WithParts[]) {
    if (active.has(sessionID)) cache.set(sessionID, messages)
  }

  export function upsertMessage(sessionID: string, info: MessageV2.Info) {
    const list = get(sessionID)
    if (!list) return
    const idx = list.findIndex((m) => m.info.id === info.id)
    const next = list.slice()
    if (idx >= 0) {
      next[idx] = { info, parts: list[idx].parts }
    } else {
      next.splice(insertionIndex(list, info.id, (m) => m.info.id), 0, { info, parts: [] })
    }
    cache.set(sessionID, next)
  }

  export function upsertPart(sessionID: string, part: MessageV2.Part) {
    const list = get(sessionID)
    if (!list) return
    const mi = list.findIndex((m) => m.info.id === part.messageID)
    if (mi < 0) {
      // A part for a message the cache has not seen: bail to a fresh read rather
      // than guess. Rare — messages are created before their parts stream.
      invalidate(sessionID)
      return
    }
    const msg = list[mi]
    const pi = msg.parts.findIndex((p) => p.id === part.id)
    const parts = msg.parts.slice()
    if (pi >= 0) parts[pi] = part
    else parts.splice(insertionIndex(msg.parts, part.id, (p) => p.id), 0, part)
    const next = list.slice()
    next[mi] = { info: msg.info, parts }
    cache.set(sessionID, next)
  }

  // Ascending-by-id insertion point. Message/part ids are monotonic, so this is
  // an append in the common case; binary search keeps out-of-order inserts sane.
  function insertionIndex<T>(arr: T[], id: string, idOf: (t: T) => string): number {
    let lo = 0
    let hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (idOf(arr[mid]) < id) lo = mid + 1
      else hi = mid
    }
    return lo
  }
}
