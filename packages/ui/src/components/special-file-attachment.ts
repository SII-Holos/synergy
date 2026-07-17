import type { AttachmentPart } from "@ericsanchezok/synergy-sdk"

export function specialFileAttachmentSessionID(file: AttachmentPart, kind: "note" | "session") {
  const sessionID = file.metadata?.sessionId
  if (kind !== "session" || typeof sessionID !== "string" || !/^ses_[A-Za-z0-9]+$/.test(sessionID)) return undefined
  return sessionID
}

export function navigateToSessionAttachment(input: {
  file: AttachmentPart
  kind: "note" | "session"
  navigateToSession?: (sessionID: string) => void
}) {
  const sessionID = specialFileAttachmentSessionID(input.file, input.kind)
  if (!sessionID || !input.navigateToSession) return false
  input.navigateToSession(sessionID)
  return true
}
