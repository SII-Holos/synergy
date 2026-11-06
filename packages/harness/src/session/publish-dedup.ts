// Server-side dedup for session.updated events (issue #319, defense in depth).
//
// BlueprintLoop and other flows call Session.update frequently; many of those
// writes change nothing the frontend renders (or only bump time.updated). Even
// with the frontend now reconciling instead of replacing, suppressing redundant
// publishes cuts event volume and wake-ups. A real field change always
// publishes immediately; a diff limited to time.updated (or a byte-identical
// payload) is throttled to a low-frequency heartbeat.

/**
 * Serialization of a session info used to detect meaningful changes: everything
 * except time.updated. Two infos differing only in time.updated (or identical)
 * produce the same key. Ordering is by construction stable enough that any real
 * field change alters the string; at worst key order shifts cause an extra
 * publish (safe) — a real change can never be dropped.
 */
export function publishCompareKey(info: unknown): string {
  if (!info || typeof info !== "object") return JSON.stringify(info)
  const clone = { ...(info as Record<string, unknown>) }
  const time = clone.time
  if (time && typeof time === "object") {
    const timeClone = { ...(time as Record<string, unknown>) }
    delete timeClone.updated
    clone.time = timeClone
  }
  return JSON.stringify(clone)
}

/**
 * Decide whether a candidate session info should be published given the last
 * published state. Returns true (publish) when there is no prior publish, when
 * a meaningful field changed, or when the throttle window has elapsed for an
 * otherwise-unchanged (time.updated-only) payload.
 */
export function decideSessionPublish(args: {
  prevKey: string | undefined
  prevAt: number | undefined
  nextKey: string
  now: number
  throttleMs: number
}): boolean {
  if (args.prevKey === undefined || args.prevAt === undefined) return true
  if (args.nextKey !== args.prevKey) return true
  return args.now - args.prevAt >= args.throttleMs
}
