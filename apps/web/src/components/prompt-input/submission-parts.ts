import type { Part, SessionPartSummary } from "@ericsanchezok/synergy-sdk/client"
import type {
  FileAttachmentPart,
  FileContextItem,
  NoteAttachmentPart,
  Prompt,
  SessionAttachmentPart,
  UploadedAttachmentPart,
} from "@/context/prompt"
import { base64EncodeStandard } from "@ericsanchezok/synergy-util/encode"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { Identifier } from "@/utils/id"
import { formatNoteContent, formatSessionReference, inlineText } from "./content"
import { createUploadedAttachmentInputPart } from "./attachment-submit"

export function createSubmissionPartIDs() {
  const ids = new Map<string, string>([["text", Identifier.ascending("part")]])
  return (key: string) => {
    const existing = ids.get(key)
    if (existing) return existing
    const id = Identifier.ascending("part")
    ids.set(key, id)
    return id
  }
}

export function createSubmissionParts(input: {
  id: ReturnType<typeof createSubmissionPartIDs>
  prompt: Prompt
  context: readonly FileContextItem[]
  attachments: readonly UploadedAttachmentPart[]
  notes: readonly NoteAttachmentPart[]
  sessions: readonly SessionAttachmentPart[]
  workspace?: string | null
  sessionContent?: ReadonlyMap<string, string>
}) {
  const absolute = (path: string) => {
    if (path.startsWith("/")) return path
    if (!input.workspace) throw new Error("File references require a session workspace")
    return `${input.workspace}/${path}`.replace("//", "/")
  }
  const filePart = (attachment: FileAttachmentPart | FileContextItem, index: number) => {
    const path = absolute(attachment.path)
    const query = attachment.selection
      ? `?start=${attachment.selection.startLine}&end=${attachment.selection.endLine}`
      : ""
    const url = `file://${path}${query}`
    return {
      id: input.id(
        "content" in attachment ? `file:${index}:${attachment.path}${query}` : `context:${attachment.path}${query}`,
      ),
      type: "attachment" as const,
      mime: "text/plain",
      url,
      filename: getFilename(attachment.path),
      model: { mode: "content" as const },
      ...("content" in attachment
        ? {
            source: {
              type: "file" as const,
              text: { value: attachment.content, start: attachment.start, end: attachment.end },
              path,
            },
          }
        : {}),
    }
  }
  const files = input.prompt.filter((part): part is FileAttachmentPart => part.type === "file").map(filePart)
  const used = new Set(files.map((part) => part.url))
  const context = input.context.flatMap((item, index) => {
    const part = filePart(item, index)
    if (used.has(part.url)) return []
    used.add(part.url)
    return [part]
  })
  return [
    { id: input.id("text"), type: "text" as const, text: inlineText(input.prompt) },
    ...files,
    ...context,
    ...input.attachments.map((part) => createUploadedAttachmentInputPart(part, input.id(`upload:${part.id}`))),
    ...input.notes.map((part) => ({
      id: input.id(`note:${part.id}`),
      type: "attachment" as const,
      mime: "text/plain",
      url: `data:text/plain;base64,${base64EncodeStandard(formatNoteContent(part))}`,
      filename: `${part.title || "Untitled"}.md`,
      model: { mode: "content" as const, text: formatNoteContent(part) },
      metadata: { kind: "note", noteId: part.noteId, title: part.title || "Untitled" },
    })),
    ...input.sessions.map((part) => {
      const content = input.sessionContent?.get(part.id) ?? formatSessionReference(part)
      return {
        id: input.id(`session:${part.id}`),
        type: "attachment" as const,
        mime: "text/plain",
        url: `data:text/plain;base64,${base64EncodeStandard(content)}`,
        filename: `${part.title || "session"}.session.txt`,
        model: { mode: "content" as const, text: content },
        metadata: {
          kind: "session",
          sessionId: part.sessionId,
          scopeID: part.scopeID,
          title: part.title || "Untitled",
          updatedAt: part.updatedAt,
        },
      }
    }),
  ].sort((a, b) => a.id.localeCompare(b.id))
}

export function optimisticPartSummaries(parts: readonly Part[]): SessionPartSummary[] {
  return parts
    .map((part) => ({
      id: part.id,
      messageID: part.messageID,
      sessionID: part.sessionID,
      type: part.type,
      preview: "text" in part ? part.text.slice(0, 256) : "",
      content: { version: `optimistic:${part.id}`, bytes: JSON.stringify(part).length * 2 },
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}
