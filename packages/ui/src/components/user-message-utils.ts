import type { Part as PartType, TextPart } from "@ericsanchezok/synergy-sdk"

export const USER_MESSAGE_COLLAPSE_LENGTH = 700
export const USER_MESSAGE_COLLAPSE_LINES = 12

export function userMessageLineCount(text: string) {
  if (!text) return 0
  return text.split(/\r\n|\r|\n/).length
}

export function shouldCollapseUserMessage(text: string) {
  return text.length > USER_MESSAGE_COLLAPSE_LENGTH || userMessageLineCount(text) > USER_MESSAGE_COLLAPSE_LINES
}

export function visibleUserMessageText(parts: readonly PartType[] | undefined) {
  const textPart = parts?.find((p) => p.type === "text" && !(p as TextPart).synthetic) as TextPart | undefined
  return textPart?.text || ""
}

export function hasVisibleUserMessageContent(parts: readonly PartType[] | undefined) {
  if (visibleUserMessageText(parts)) return true
  return parts?.some((part) => part.type === "attachment") ?? false
}
