import type { Part as PartType, TextPart } from "@ericsanchezok/synergy-sdk"

export const USER_MESSAGE_COLLAPSE_LENGTH = 700
export const USER_MESSAGE_COLLAPSE_LINES = 12

/**
 * Whether a part is system-injected rather than user-authored. Prefers the
 * canonical `origin`, falling back to the legacy `synthetic` flag for parts that
 * predate it. Mirror of the backend MessageV2.isSystemPart.
 */
export function isSystemPart(part: Pick<TextPart, "type" | "origin" | "synthetic">): boolean {
  if (part.type !== "text") return false
  if (part.origin !== undefined) return part.origin === "system"
  return part.synthetic === true
}

export function userMessageLineCount(text: string) {
  if (!text) return 0
  return text.split(/\r\n|\r|\n/).length
}

export function shouldCollapseUserMessage(text: string) {
  return text.length > USER_MESSAGE_COLLAPSE_LENGTH || userMessageLineCount(text) > USER_MESSAGE_COLLAPSE_LINES
}

export function visibleUserMessageText(parts: readonly PartType[] | undefined) {
  const textPart = parts?.find((p) => p.type === "text" && !isSystemPart(p as TextPart)) as TextPart | undefined
  return textPart?.text || ""
}

export function hasVisibleUserMessageContent(parts: readonly PartType[] | undefined) {
  if (visibleUserMessageText(parts)) return true
  return parts?.some((part) => part.type === "attachment") ?? false
}
