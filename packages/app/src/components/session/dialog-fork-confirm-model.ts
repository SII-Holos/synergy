/** Pure presentation helpers for the fork-confirm dialog, kept UI-free for unit testing. */

export interface ForkConfirmMessage {
  id: string
  time?: { created: number; completed?: number }
}

/** Count user messages and assistant replies copied through the target message inclusive. */
export function computeForkCounts(allMessages: { id: string; role: string }[], targetId: string) {
  const idx = allMessages.findIndex((message) => message.id === targetId)
  if (idx < 0) return { userMessages: 0, assistantReplies: 0 }
  const copied = allMessages.slice(0, idx + 1)
  return {
    userMessages: copied.filter((message) => message.role === "user").length,
    assistantReplies: copied.filter((message) => message.role === "assistant").length,
  }
}

/** Extract a short user-visible text preview from the first non-system text part. */
export function forkReplyPreview(
  parts: readonly { type: string; text?: string; origin?: string; synthetic?: boolean }[],
): string | undefined {
  for (const part of parts) {
    if (part.type !== "text") continue
    if (part.synthetic === true || part.origin === "system") continue
    const trimmed = part.text?.trim()
    if (!trimmed) continue
    return trimmed.length <= 96 ? trimmed : `${trimmed.slice(0, 95)}\u2026`
  }
  return undefined
}

export function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`
}

export function joinParts(parts: string[]) {
  if (parts.length === 0) return "the conversation"
  if (parts.length === 1) return parts[0]
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`
}
