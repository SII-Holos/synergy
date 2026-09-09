import type { Message, Part } from "@ericsanchezok/synergy-sdk/client"
import type {
  ContentPart,
  FileAttachmentPart,
  NoteAttachmentPart,
  Prompt,
  SessionAttachmentPart,
  TextPart,
} from "@/context/prompt"
import { Identifier } from "@/utils/id"

type InlinePart = TextPart | FileAttachmentPart

const NOTE_PREVIEW_MAX_LINES = 2000
export const SESSION_PREVIEW_MAX_MESSAGES = 24
const SESSION_PREVIEW_MAX_TEXT_LENGTH = 12000

export function isInlinePart(part: ContentPart): part is InlinePart {
  return part.type === "text" || part.type === "file"
}

export function inlineText(parts: Prompt): string {
  return parts
    .filter(isInlinePart)
    .map((p) => p.content)
    .join("")
}

// The editor's DOM offset counts file-pill content, matching inlineText's coordinate space.
export function inlineCompletionPrefix(parts: Prompt, domOffset: number): string {
  return inlineText(parts).slice(0, domOffset)
}

export function inlineLength(parts: Prompt): number {
  return parts.filter(isInlinePart).reduce((len, p) => len + p.content.length, 0)
}

export function createPromptPartID(): string {
  return Identifier.ascending("part")
}

export function formatSessionReference(attachment: SessionAttachmentPart): string {
  return `<session-ref id="${attachment.sessionId}" directory="${attachment.directory}" title="${attachment.title || "Untitled"}" />`
}

export function formatNoteContent(attachment: NoteAttachmentPart): string {
  const lines = attachment.content.split("\n")
  const truncated = lines.length > NOTE_PREVIEW_MAX_LINES
  const visible = truncated ? lines.slice(0, NOTE_PREVIEW_MAX_LINES).join("\n") : attachment.content
  const title = attachment.title || "Untitled"

  let result = `<note id="${attachment.noteId}" title="${title}">\n\n${visible}`

  if (truncated) {
    result += `\n\n[Truncated at line ${NOTE_PREVIEW_MAX_LINES} of ${lines.length} total — use note_read(id="${attachment.noteId}", offset=${NOTE_PREVIEW_MAX_LINES}) to view remaining content]`
  }

  result += "\n\n</note>"
  return result
}

export function formatSessionPreview(input: {
  attachment: SessionAttachmentPart
  sessionMessages: Message[]
  getParts: (messageID: string) => Part[]
}): string {
  const { attachment, sessionMessages, getParts } = input
  const title = attachment.title || "Untitled"
  const messages = sessionMessages.slice(-SESSION_PREVIEW_MAX_MESSAGES)
  const previewBlocks: string[] = []
  let totalLength = 0
  let truncated = sessionMessages.length > messages.length

  for (const message of messages) {
    const parts = getParts(message.id)
    const text = parts
      .filter((part): part is Part & { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join("\n\n")
    if (!text) continue

    const role = message.role === "assistant" ? "assistant" : "user"
    const block = `<message role="${role}" id="${message.id}">\n${text}\n</message>`
    if (totalLength + block.length > SESSION_PREVIEW_MAX_TEXT_LENGTH) {
      truncated = true
      break
    }
    previewBlocks.push(block)
    totalLength += block.length
  }

  let result = `<session-ref id="${attachment.sessionId}" directory="${attachment.directory}" title="${title}">\n`
  if (previewBlocks.length > 0) {
    result += `\n${previewBlocks.join("\n\n")}\n`
  } else {
    result += "\n[No text messages available in cached preview]\n"
  }
  if (truncated) {
    result += `\n[Truncated preview — open session ${attachment.sessionId} for fuller context]\n`
  }
  result += "\n</session-ref>"
  return result
}
