import type { SynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import type { NoteAttachmentPart, SessionAttachmentPart, UploadedAttachmentPart } from "@/context/prompt"
import { Identifier } from "@/utils/id"
import { createUploadedAttachmentInputPart } from "./attachment-submit"
import { formatNoteContent, formatSessionReference } from "./content"

export type SessionCommandModel = {
  providerID: string
  modelID: string
}

export type SessionCommandInput = {
  client: SynergyClient
  sessionID: string
  command: string
  arguments?: string
  agent: string
  model: SessionCommandModel
  variant?: string
  attachments?: UploadedAttachmentPart[]
  notes?: NoteAttachmentPart[]
  sessions?: SessionAttachmentPart[]
}

export function createSessionCommandParts(input: {
  attachments?: UploadedAttachmentPart[]
  notes?: NoteAttachmentPart[]
  sessions?: SessionAttachmentPart[]
}) {
  const attachments = input.attachments ?? []
  const notes = input.notes ?? []
  const sessions = input.sessions ?? []

  return [
    ...attachments.map(createUploadedAttachmentInputPart),
    ...notes.map((attachment) => {
      const text = formatNoteContent(attachment)
      return {
        id: Identifier.ascending("part"),
        type: "attachment" as const,
        mime: "text/plain",
        url: `data:text/plain;base64,${base64Encode(text)}`,
        filename: `${attachment.title || "Untitled"}.md`,
        model: { mode: "content" as const, text },
        metadata: {
          kind: "note",
          noteId: attachment.noteId,
          title: attachment.title || "Untitled",
        },
      }
    }),
    ...sessions.map((attachment) => {
      const text = formatSessionReference(attachment)
      return {
        id: Identifier.ascending("part"),
        type: "attachment" as const,
        mime: "text/plain",
        url: `data:text/plain;base64,${base64Encode(text)}`,
        filename: `${attachment.title || "session"}.session.txt`,
        model: { mode: "content" as const, text },
        metadata: {
          kind: "session",
          sessionId: attachment.sessionId,
          directory: attachment.directory,
          title: attachment.title || "Untitled",
          updatedAt: attachment.updatedAt,
        },
      }
    }),
  ]
}

export function sendSessionCommand(input: SessionCommandInput) {
  return input.client.session.command({
    sessionID: input.sessionID,
    command: input.command,
    arguments: input.arguments ?? "",
    agent: input.agent,
    model: `${input.model.providerID}/${input.model.modelID}`,
    variant: input.variant,
    parts: createSessionCommandParts({
      attachments: input.attachments,
      notes: input.notes,
      sessions: input.sessions,
    }),
  })
}
