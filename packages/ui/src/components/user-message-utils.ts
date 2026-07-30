import type { AttachmentPart, Part as PartType, TextPart } from "@ericsanchezok/synergy-sdk"

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

type InlineFileReference = {
  start: number
  end: number
  value: string
}

function inlineFileReferences(parts: readonly PartType[] | undefined): InlineFileReference[] | undefined {
  const references: InlineFileReference[] = []
  for (const part of parts ?? []) {
    if (part.type !== "attachment") continue
    const source = (part as AttachmentPart).source
    if (source?.type !== "file") continue
    const text = source.text
    if (
      !text ||
      typeof text.value !== "string" ||
      text.value.length === 0 ||
      !Number.isInteger(text.start) ||
      !Number.isInteger(text.end) ||
      text.start < 0 ||
      text.end <= text.start ||
      text.end - text.start !== text.value.length
    )
      return undefined
    references.push({ start: text.start, end: text.end, value: text.value })
  }
  return references.sort((a, b) => a.start - b.start)
}

function restoreLegacyInlineFileText(text: string, references: InlineFileReference[]) {
  if (references.length === 0 || references.every((ref) => text.slice(ref.start, ref.end) === ref.value)) return text
  if (references.some((ref) => text.includes(ref.value))) return text

  const restoredLength = text.length + references.reduce((total, ref) => total + ref.value.length, 0)
  let previousEnd = 0
  let restored = text
  for (const ref of references) {
    if (ref.start < previousEnd || ref.end > restoredLength || ref.start > restored.length) return text
    restored = `${restored.slice(0, ref.start)}${ref.value}${restored.slice(ref.start)}`
    if (restored.slice(ref.start, ref.end) !== ref.value) return text
    previousEnd = ref.end
  }
  return restored
}

export function visibleUserMessageText(parts: readonly PartType[] | undefined) {
  const textPart = parts?.find((p) => p.type === "text" && !isSystemPart(p as TextPart)) as TextPart | undefined
  const text = textPart?.text || ""
  const references = inlineFileReferences(parts)
  return references ? restoreLegacyInlineFileText(text, references) : text
}

export function hasVisibleUserMessageContent(parts: readonly PartType[] | undefined) {
  if (visibleUserMessageText(parts)) return true
  return parts?.some((part) => part.type === "attachment") ?? false
}
