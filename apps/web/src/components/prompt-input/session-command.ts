import type { SynergyClient } from "@ericsanchezok/synergy-sdk/client"
import type {
  NoteAttachmentPart,
  QuoteAttachmentPart,
  SessionAttachmentPart,
  UploadedAttachmentPart,
} from "@/context/prompt"
import { Identifier } from "@/utils/id"
import { createUploadedAttachmentInputPart } from "./attachment-submit"
import { referenceAttachmentInputPart } from "./reference-part"

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
  quotes?: QuoteAttachmentPart[]
}

export function createSessionCommandParts(input: {
  attachments?: UploadedAttachmentPart[]
  notes?: NoteAttachmentPart[]
  sessions?: SessionAttachmentPart[]
  quotes?: QuoteAttachmentPart[]
}) {
  const attachments = input.attachments ?? []
  const notes = input.notes ?? []
  const sessions = input.sessions ?? []
  const quotes = input.quotes ?? []

  return [
    ...attachments.map((attachment) => createUploadedAttachmentInputPart(attachment)),
    ...notes.map((part) => referenceAttachmentInputPart(part, Identifier.ascending("part"))),
    ...sessions.map((part) => referenceAttachmentInputPart(part, Identifier.ascending("part"))),
    ...quotes.map((part) => referenceAttachmentInputPart(part, Identifier.ascending("part"))),
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
      quotes: input.quotes,
    }),
  })
}
