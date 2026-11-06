// LRU eviction policy for loaded message/part buckets (frontend sync redesign,
// C7 — the message and part stores previously grew unbounded as the user
// switched between sessions). Pure decision so it can be unit-tested; the caller
// performs the actual store deletion.

/**
 * Given session keys in LRU order (oldest first), decide which to evict so that
 * at most `cap` remain. `protectedIds` (e.g. the actively-viewed session) are
 * never evicted regardless of position, so eviction can never drop the active
 * timeline. Evicts oldest-first among the rest.
 */
export function planBucketEviction(
  lruOldestFirst: readonly string[],
  cap: number,
  protectedIds: ReadonlySet<string>,
): string[] {
  if (lruOldestFirst.length <= cap) return []
  const evictable = lruOldestFirst.filter((id) => !protectedIds.has(id))
  const budget = Math.max(0, cap - protectedIds.size)
  const evictCount = Math.max(0, evictable.length - budget)
  return evictable.slice(0, evictCount)
}
