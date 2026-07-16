import { MessageV2 } from "./message-v2"

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

  // Global memory bound (issue #350 P2-8). Each active loop holds its full raw
  // history in memory; N concurrent long sessions would otherwise grow without
  // limit. We track an approximate byte footprint per session and evict the
  // least-recently-used entry once the total exceeds the budget. Eviction is
  // transparent: a dropped entry is re-read from disk on the next `get` (the
  // cache is an accelerator, never the source of truth — R3), so the only cost
  // is one extra read for the coldest session under pressure.
  const sizes = new Map<string, number>()
  const lru: string[] = []
  let totalBytes = 0
  const DEFAULT_BYTE_BUDGET = 256 * 1024 * 1024
  // Read on each eviction so SYNERGY_SESSION_CACHE_MAX_BYTES can be tuned (and
  // set by tests) without a restart; the cost is a trivial env parse on writes.
  function byteBudget() {
    const env = Number.parseInt(process.env.SYNERGY_SESSION_CACHE_MAX_BYTES ?? "", 10)
    return Number.isFinite(env) && env > 0 ? env : DEFAULT_BYTE_BUDGET
  }

  /** Begin the single-writer window for a session (loop start). */
  export function enable(sessionID: string) {
    active.add(sessionID)
  }

  /** End the window and drop the entry (loop exit). */
  export function disable(sessionID: string) {
    active.delete(sessionID)
    drop(sessionID)
  }

  /** Drop the cached list but keep the window open; the next read repopulates. */
  export function invalidate(sessionID: string) {
    drop(sessionID)
  }

  export function isActive(sessionID: string) {
    return active.has(sessionID)
  }

  /** Cached raw list, or undefined when the window is closed or unpopulated. */
  export function get(sessionID: string): MessageV2.WithParts[] | undefined {
    if (!active.has(sessionID)) return undefined
    const hit = cache.get(sessionID)
    if (hit) touch(sessionID)
    return hit
  }

  /** Seed the cache from a fresh disk read (no-op outside the window). */
  export function set(sessionID: string, messages: MessageV2.WithParts[]) {
    if (!active.has(sessionID)) return
    cache.set(sessionID, messages)
    setSize(sessionID, estimateList(messages))
    touch(sessionID)
    evict(sessionID)
  }

  export function upsertMessage(sessionID: string, info: MessageV2.Info) {
    const list = get(sessionID)
    if (!list) return
    const idx = list.findIndex((m) => m.info.id === info.id)
    const next = list.slice()
    let delta: number
    if (idx >= 0) {
      next[idx] = { info, parts: list[idx].parts }
      delta = estimateInfo(info) - estimateInfo(list[idx].info)
    } else {
      next.splice(messageInsertionIndex(list, info), 0, { info, parts: [] })
      delta = estimateInfo(info)
    }
    cache.set(sessionID, next)
    addSize(sessionID, delta)
    touch(sessionID)
    evict(sessionID)
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
    let delta: number
    if (pi >= 0) {
      delta = estimatePart(part) - estimatePart(parts[pi])
      parts[pi] = part
    } else {
      parts.splice(
        insertionIndex(msg.parts, part.id, (p) => p.id),
        0,
        part,
      )
      delta = estimatePart(part)
    }
    const next = list.slice()
    next[mi] = { info: msg.info, parts }
    cache.set(sessionID, next)
    addSize(sessionID, delta)
    touch(sessionID)
    evict(sessionID)
  }

  // --- Footprint accounting & LRU eviction ---

  function drop(sessionID: string) {
    cache.delete(sessionID)
    const size = sizes.get(sessionID)
    if (size !== undefined) {
      totalBytes -= size
      sizes.delete(sessionID)
    }
    const i = lru.indexOf(sessionID)
    if (i !== -1) lru.splice(i, 1)
  }

  function touch(sessionID: string) {
    const i = lru.indexOf(sessionID)
    if (i !== -1) lru.splice(i, 1)
    lru.push(sessionID)
  }

  function setSize(sessionID: string, bytes: number) {
    totalBytes += bytes - (sizes.get(sessionID) ?? 0)
    sizes.set(sessionID, bytes)
  }

  function addSize(sessionID: string, delta: number) {
    const current = sizes.get(sessionID)
    if (current === undefined) return
    sizes.set(sessionID, Math.max(0, current + delta))
    totalBytes = Math.max(0, totalBytes + delta)
  }

  // Evict least-recently-used entries until under budget, never evicting the
  // session currently being written (it would just re-read on the next step and
  // thrash). A single over-budget session is left resident: shrinking its own
  // working set would force a disk re-read every step.
  function evict(protect: string) {
    const budget = byteBudget()
    if (totalBytes <= budget) return
    for (let i = 0; i < lru.length && totalBytes > budget; ) {
      const victim = lru[i]
      if (victim === protect) {
        i++
        continue
      }
      drop(victim)
    }
  }

  function estimatePart(part: MessageV2.Part): number {
    try {
      return JSON.stringify(part).length
    } catch {
      return 0
    }
  }

  function estimateInfo(info: MessageV2.Info): number {
    try {
      return JSON.stringify(info).length
    } catch {
      return 0
    }
  }

  function estimateList(list: MessageV2.WithParts[]): number {
    let total = 0
    for (const m of list) {
      total += estimateInfo(m.info)
      for (const p of m.parts) total += estimatePart(p)
    }
    return total
  }

  function messageInsertionIndex(messages: MessageV2.WithParts[], info: MessageV2.Info): number {
    let lo = 0
    let hi = messages.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (MessageV2.compareStorageOrder(messages[mid].info, info) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

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
