import type { Part, SessionPartSummary } from "@ericsanchezok/synergy-sdk/client"
import type {
  FileAttachmentPart,
  FileContextItem,
  NoteAttachmentPart,
  Prompt,
  QuoteAttachmentPart,
  SessionAttachmentPart,
  UploadedAttachmentPart,
} from "@/context/prompt"
import { getFilename } from "@ericsanchezok/synergy-util/path"
import { Identifier } from "@/utils/id"
import { inlineText } from "./content"
import { referenceAttachmentInputPart } from "./reference-part"
import { createUploadedAttachmentInputPart } from "./attachment-submit"
import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"

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
  quotes: readonly QuoteAttachmentPart[]
  workspace?: string | null
  sessionContent?: ReadonlyMap<string, string>
}) {
  const absolute = (path: string, workspace?: ResourceReference.Workspace) => {
    if (path.startsWith("/") || /^[a-z]:[\\/]/i.test(path)) return path
    const root = workspace?.root ?? input.workspace
    if (!root) throw new Error("File references require a session workspace")
    return `${root.replace(/[\\/]$/, "")}/${path}`
  }
  const filePart = (attachment: FileAttachmentPart | FileContextItem, index: number) => {
    const path = absolute(attachment.path, attachment.workspace)
    const query = attachment.selection
      ? `?start=${attachment.selection.startLine}&end=${attachment.selection.endLine}`
      : ""
    const url = `${ResourceReference.fileUrl(path)}${query}`
    return {
      id: input.id(
        "content" in attachment ? `file:${index}:${attachment.path}${query}` : `context:${attachment.path}${query}`,
      ),
      type: "attachment" as const,
      mime: "text/plain",
      url,
      filename: getFilename(attachment.path),
      model: { mode: "content" as const },
      ...("content" in attachment || attachment.workspace
        ? {
            source: {
              type: "file" as const,
              text:
                "content" in attachment
                  ? { value: attachment.content, start: attachment.start, end: attachment.end }
                  : { value: "", start: 0, end: 0 },
              path,
              ...(attachment.workspace ? { workspace: attachment.workspace } : {}),
              ...(attachment.selection
                ? {
                    location: {
                      kind: "text" as const,
                      line: attachment.selection.startLine,
                      endLine: attachment.selection.endLine,
                    },
                  }
                : {}),
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
    ...input.notes.map((part) => referenceAttachmentInputPart(part, input.id(`note:${part.id}`))),
    ...input.sessions.map((part) =>
      referenceAttachmentInputPart(part, input.id(`session:${part.id}`), {
        sessionText: input.sessionContent?.get(part.id),
      }),
    ),
    ...input.quotes.map((part) => referenceAttachmentInputPart(part, input.id(`quote:${part.id}`))),
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
