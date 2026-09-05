/**
 * Speak-autoplay tracking.
 *
 * The speak tool delivers speech the agent decided to announce, so a card
 * that the user just watched being generated should play once on its own.
 * Only parts that were observed in an active (pending/generating/running)
 * state and later completed qualify: history replay, reconnect, and window
 * reload mount parts already completed and must never start audio on their
 * own.
 *
 * Tracking is module-level keyed by tool-part ID with a time-to-live, and
 * consumption is one-shot — the entry is removed when the completed part
 * first renders, so re-renders and projection switches cannot replay it.
 */

const SEEN_ACTIVE_TTL_MS = 10 * 60 * 1000

const seenActive = new Map<string, number>()

function prune() {
  const now = Date.now()
  if (seenActive.size < 64) return
  for (const [partID, seenAt] of seenActive) {
    if (now - seenAt > SEEN_ACTIVE_TTL_MS) seenActive.delete(partID)
  }
}

export function resetSpeakAutoplayTrackerForTest() {
  seenActive.clear()
}

export function isSpeakTool(tool: string | undefined): boolean {
  return tool === "speak"
}

/** Record that a speak part is generating right now in this live turn. */
export function noteSpeakPartActive(partID: string) {
  prune()
  seenActive.set(partID, Date.now())
}

/**
 * One-shot claim for a completed speak part. Returns true exactly once (the
 * first completed render after the part was observed active), which is when
 * the freshly generated audio should autoplay.
 */
export function claimSpeakAutoplay(partID: string): boolean {
  prune()
  const seenAt = seenActive.get(partID)
  if (seenAt === undefined) return false
  if (Date.now() - seenAt > SEEN_ACTIVE_TTL_MS) {
    seenActive.delete(partID)
    return false
  }
  seenActive.delete(partID)
  return true
}
