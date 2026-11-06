import type { NoteAttachmentPart, QuoteAttachmentPart, SessionAttachmentPart } from "@/context/prompt"
import { base64EncodeStandard } from "@ericsanchezok/synergy-util/encode"
import { formatNoteContent, formatQuoteContent, formatSessionReference } from "./content"

/** Composer references that reach the model as a text attachment. */
export type ReferenceAttachmentPart = NoteAttachmentPart | SessionAttachmentPart | QuoteAttachmentPart

export function referencePartTitle(part: ReferenceAttachmentPart) {
  if (part.type === "quote") return part.text.replace(/\s+/g, " ").trim()
  return part.title
}

export function referenceAttachmentInputPart(
  part: ReferenceAttachmentPart,
  id: string,
  options?: { sessionText?: string },
) {
  const attachment = (text: string, filename: string, metadata: Record<string, unknown>) => ({
    id,
    type: "attachment" as const,
    mime: "text/plain",
    url: `data:text/plain;base64,${base64EncodeStandard(text)}`,
    filename,
    model: { mode: "content" as const, text },
    metadata,
  })
  if (part.type === "note") {
    return attachment(formatNoteContent(part), `${part.title || "Untitled"}.md`, {
      kind: "note",
      noteId: part.noteId,
      title: part.title || "Untitled",
    })
  }
  if (part.type === "session") {
    return attachment(options?.sessionText ?? formatSessionReference(part), `${part.title || "session"}.session.txt`, {
      kind: "session",
      sessionId: part.sessionId,
      scopeID: part.scopeID,
      title: part.title || "Untitled",
      updatedAt: part.updatedAt,
    })
  }
  return attachment(formatQuoteContent(part), "quote.txt", {
    kind: "quote",
    text: part.text,
    ...(part.role ? { role: part.role } : {}),
  })
}
