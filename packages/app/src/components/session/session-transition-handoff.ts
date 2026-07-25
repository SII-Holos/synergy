import type { SessionTransitionProgress } from "./session-transition-progress"

export type SessionTransitionHandoff = {
  messageID: string
  success: SessionTransitionProgress
}

export function isSessionTransitionHandoffReady(
  messageID: string | undefined,
  messages: ReadonlyArray<{
    id: string
    role: string
    isRoot?: boolean
    visible?: boolean
  }>,
): boolean {
  if (!messageID) return false
  return messages.some(
    (message) =>
      message.id === messageID && message.role === "user" && message.isRoot === true && message.visible !== false,
  )
}
