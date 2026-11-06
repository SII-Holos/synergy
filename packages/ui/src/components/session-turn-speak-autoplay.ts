/**
 * Speak-autoplay tracking.
 *
 * The speak tool delivers speech the agent decided to announce, so an audio
 * card the user just watched being generated should play on its own — and
 * keep playing across the turn-settlement re-projection that remounts
 * conversation cards while the audio is still in flight.
 *
 * Only parts observed in an active (pending/generating/running) state and
 * later completed qualify: history replay, reconnect, and window reload mount
 * parts already completed and must never start audio on their own.
 *
 * Observation happens at the SessionTurn part level (all activity-display
 * modes). A part observed active and later completed becomes
 * autoplay-qualified, and the qualification stays until playback actually
 * ends or the user pauses — a remount caused by turn settlement therefore
 * resumes the speech from its remembered position instead of silencing it,
 * while an already-finished clip never replays.
 *
 * Keys are the full `speak:<partID>` autoplay keys shared with
 * AttachmentCard, so both sides address the same track.
 */

const ENTRY_TTL_MS = 10 * 60 * 1000
const MAX_ENTRIES = 128

const seenActive = new Map<string, number>()
const qualified = new Map<string, number>()
const playbackPosition = new Map<string, number>()

function prune(map: Map<string, number>) {
  const now = Date.now()
  if (map.size < MAX_ENTRIES) return
  for (const [key, at] of map) {
    if (now - at > ENTRY_TTL_MS) map.delete(key)
  }
}

export function resetSpeakAutoplayTrackerForTest() {
  seenActive.clear()
  qualified.clear()
  playbackPosition.clear()
}

export function isSpeakTool(tool: string | undefined): boolean {
  return tool === "speak"
}

/** Record that a speak part is generating right now in this live turn. */
export function noteSpeakPartActive(key: string) {
  prune(seenActive)
  seenActive.set(key, Date.now())
}

/**
 * Resolve whether a speak part is autoplay-qualified. A part observed active
 * and now completed qualifies once; qualification is sticky until
 * finishSpeakAutoplay (playback ended or user paused), so re-renders and
 * projection switches keep it. Parts first observed already completed
 * (history replay, reconnect, reload) never qualify.
 */
export function claimSpeakAutoplay(key: string): boolean {
  prune(seenActive)
  prune(qualified)
  if (qualified.has(key)) return true
  const seenAt = seenActive.get(key)
  if (seenAt === undefined) return false
  if (Date.now() - seenAt > ENTRY_TTL_MS) {
    seenActive.delete(key)
    return false
  }
  seenActive.delete(key)
  qualified.set(key, Date.now())
  return true
}

/** Playback ended or the user paused — stop autoplaying on later remounts. */
export function finishSpeakAutoplay(key: string | undefined) {
  if (!key) return
  qualified.delete(key)
  playbackPosition.delete(key)
}

/** Remember where playback was so a remounted card can resume from there. */
export function rememberSpeakPlaybackPosition(key: string | undefined, time: number) {
  if (!key) return
  prune(playbackPosition)
  playbackPosition.set(key, time)
}

/** Last remembered playback position for the key (0 when none). */
export function speakPlaybackPosition(key: string | undefined): number {
  if (!key) return 0
  return playbackPosition.get(key) ?? 0
}
