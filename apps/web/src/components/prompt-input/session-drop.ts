import type { SessionAttachmentPart } from "@/context/prompt"
import type { DroppedSessionData } from "./types"

export type DroppedSessionDecision = { accepted: true } | { accepted: false; reason: "invalid" | "self" | "duplicate" }

export function decideDroppedSession(
  dropped: DroppedSessionData,
  currentSessionID: string | undefined,
  existing: readonly SessionAttachmentPart[],
): DroppedSessionDecision {
  if (!dropped.id || !dropped.scopeID) return { accepted: false, reason: "invalid" }
  if (dropped.id === currentSessionID) return { accepted: false, reason: "self" }
  if (existing.some((attachment) => attachment.sessionId === dropped.id && attachment.scopeID === dropped.scopeID)) {
    return { accepted: false, reason: "duplicate" }
  }
  return { accepted: true }
}
