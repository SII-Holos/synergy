import type { SessionAttachmentPart } from "@/context/prompt"
import type { DroppedSessionData } from "./types"

export type DroppedSessionDecision = { accepted: true } | { accepted: false; reason: "invalid" | "self" | "duplicate" }

/**
 * Decide whether a dropped session payload should become a session reference.
 *
 * Session IDs are globally unique, so self-references are rejected by ID
 * alone; the directory is only required to be non-empty (home-scope sessions
 * carry the reserved "home" token).
 */
export function decideDroppedSession(
  dropped: DroppedSessionData,
  currentSessionID: string | undefined,
  existing: readonly SessionAttachmentPart[],
): DroppedSessionDecision {
  if (!dropped.id || !dropped.directory) return { accepted: false, reason: "invalid" }
  if (dropped.id === currentSessionID) return { accepted: false, reason: "self" }
  if (
    existing.some((attachment) => attachment.sessionId === dropped.id && attachment.directory === dropped.directory)
  ) {
    return { accepted: false, reason: "duplicate" }
  }
  return { accepted: true }
}
