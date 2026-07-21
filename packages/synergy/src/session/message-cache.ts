import { MessageV2 } from "./message-v2"
import { applyModelWorkingSetProjection, modelWorkingSetProjection } from "./model-working-set"
import { LLMTurnMemory } from "./llm-memory"

// Loop-scoped in-memory model working-set cache (issue #350 D2).
//
// The invoke loop assembles model context on every step. The cache holds only
// the compaction-aware working set and is maintained by the loop's own writes,
// avoiding both repeated disk reads and retention of the full transcript.
//
// Correctness rests on the single-active-loop invariant: the cache is trusted
// only while a loop owns the session and is its sole writer. Structural changes
// invalidate it, loop exit drops it, and disk remains authoritative for recovery.
//
// Maintenance is immutable so a list already handed to a caller remains a valid
// snapshot while later writes advance the cache.
export namespace SessionMessageCache {
  const active = new Set<string>()
  const cache = new Map<string, MessageV2.WithParts[]>()

  // Bound the aggregate footprint of concurrent model working sets. Eviction is
  // transparent because the next read reconstructs the working set from disk.
  const sizes = new Map<string, number>()
  const lru: string[] = []
  let totalBytes = 0
  let hits = 0
  let misses = 0
  let evictions = 0
  let protectedOverbudget = 0
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

  /** Cached model working set, or undefined when closed or unpopulated. */
  export function get(sessionID: string): MessageV2.WithParts[] | undefined {
    return read(sessionID, true)
  }

  function read(sessionID: string, countStats: boolean): MessageV2.WithParts[] | undefined {
    if (!active.has(sessionID)) return undefined
    const hit = cache.get(sessionID)
    if (hit) {
      if (countStats) hits++
      touch(sessionID)
    } else if (countStats) {
      misses++
    }
    return hit
  }

  export function stats() {
    const entries = [...sizes]
      .map(([sessionID, estimatedBytes]) => ({ sessionID, estimatedBytes }))
      .sort((a, b) => b.estimatedBytes - a.estimatedBytes || a.sessionID.localeCompare(b.sessionID))
    return {
      totalBytes,
      activeCount: active.size,
      entryCount: cache.size,
      hits,
      misses,
      evictions,
      protectedOverbudget,
      entries: entries.slice(0, 100),
      truncatedEntryCount: Math.max(0, entries.length - 100),
    }
  }

  export function resetStatsForTest() {
    hits = 0
    misses = 0
    evictions = 0
    protectedOverbudget = 0
  }

  /** Seed from a fresh compaction-aware disk read (no-op outside the window). */
  export function set(sessionID: string, messages: MessageV2.WithParts[]) {
    if (!active.has(sessionID)) return
    const workingSet = projectModelWorkingSet(messages)
    const size = estimateList(workingSet)
    if (size > byteBudget()) {
      drop(sessionID)
      return
    }
    cache.set(sessionID, workingSet)
    setSize(sessionID, size)
    touch(sessionID)
    evict(sessionID)
  }

  export function upsertMessage(sessionID: string, info: MessageV2.Info) {
    const list = read(sessionID, false)
    if (!list) return
    const idx = list.findIndex((m) => m.info.id === info.id)
    const next = list.slice()
    const previous = idx >= 0 ? list[idx].info : undefined
    if (idx >= 0) {
      next[idx] = { info, parts: list[idx].parts }
    } else {
      next.splice(messageInsertionIndex(list, info), 0, { info, parts: [] })
    }
    if (info.role === "assistant" && info.summary && info.finish) {
      replaceProjected(sessionID, next)
      return
    }
    cache.set(sessionID, next)
    addSize(sessionID, estimateInfo(info) - (previous ? estimateInfo(previous) : 0))
    touch(sessionID)
    evict(sessionID)
  }

  export function upsertPart(sessionID: string, part: MessageV2.Part) {
    const list = read(sessionID, false)
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
    const previous = pi >= 0 ? msg.parts[pi] : undefined
    const parts = msg.parts.slice()
    if (pi >= 0) {
      parts[pi] = part
    } else {
      parts.splice(
        insertionIndex(msg.parts, part.id, (p) => p.id),
        0,
        part,
      )
    }
    const next = list.slice()
    next[mi] = { info: msg.info, parts }
    if (part.type === "compaction") {
      replaceProjected(sessionID, next)
      return
    }
    cache.set(sessionID, next)
    addSize(sessionID, estimatePart(part) - (previous ? estimatePart(previous) : 0))
    touch(sessionID)
    evict(sessionID)
  }

  function replaceProjected(sessionID: string, messages: MessageV2.WithParts[]) {
    const workingSet = projectModelWorkingSet(messages)
    cache.set(sessionID, workingSet)
    setSize(sessionID, estimateList(workingSet))
    touch(sessionID)
    evict(sessionID)
  }

  function projectModelWorkingSet(messages: MessageV2.WithParts[]) {
    const projection = modelWorkingSetProjection(messages.map((message) => message.info))
    if (!projection) return messages
    const boundary = messages[projection.boundaryIndex]
    if (!boundary.parts.some((part) => part.type === "compaction")) return messages
    return applyModelWorkingSetProjection(
      messages,
      projection,
      (message) => message.info,
      (message) => ({ ...message, info: { ...message.info, includeInContext: false } }),
    )
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

  function addSize(sessionID: string, bytes: number) {
    const current = sizes.get(sessionID)
    if (current === undefined) return
    totalBytes += bytes
    sizes.set(sessionID, current + bytes)
  }

  // Evict least-recently-used entries until under budget. The current writer is
  // protected only while its own entry fits the budget; a single oversized
  // working set must not make the aggregate limit ineffective.
  function evict(protect: string) {
    const budget = byteBudget()
    if (totalBytes <= budget) return
    if ((sizes.get(protect) ?? 0) > budget) drop(protect)
    for (let i = 0; i < lru.length && totalBytes > budget; ) {
      const victim = lru[i]
      if (victim === protect) {
        i++
        continue
      }
      drop(victim)
      evictions++
    }
    if (totalBytes > budget) protectedOverbudget++
  }

  function estimatePart(part: MessageV2.Part): number {
    return LLMTurnMemory.estimateBytes(part)
  }

  function estimateInfo(info: MessageV2.Info): number {
    return LLMTurnMemory.estimateBytes(info)
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
