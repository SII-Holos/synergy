import type { AttachmentPart, Part, TextPart, UserMessage } from "@ericsanchezok/synergy-sdk"

type RewindRetryTextPart = Omit<TextPart, "id" | "sessionID" | "messageID" | "time">
type RewindRetryAttachmentPart = Omit<AttachmentPart, "id" | "sessionID" | "messageID">

export type RewindRetryInput = {
  sessionID: string
  model: UserMessage["model"]
  agent: string
  parts: Array<RewindRetryTextPart | RewindRetryAttachmentPart>
  metadata?: Record<string, unknown>
  summary?: { title?: string }
  tools?: Record<string, boolean>
  system?: string
  variant?: string
}

function retryPart(part: Part): RewindRetryTextPart | RewindRetryAttachmentPart | undefined {
  if (part.type === "text") {
    if (part.origin === "system" || part.synthetic === true) return undefined
    return {
      type: "text",
      text: part.text,
      ...(part.origin ? { origin: part.origin } : {}),
      ...(part.metadata ? { metadata: part.metadata } : {}),
    }
  }
  if (part.type === "attachment") {
    return {
      type: "attachment",
      mime: part.mime,
      url: part.url,
      ...(part.filename ? { filename: part.filename } : {}),
      ...(part.localPath ? { localPath: part.localPath } : {}),
      ...(part.source ? { source: part.source } : {}),
      ...(part.presentation ? { presentation: part.presentation } : {}),
      ...(part.model ? { model: part.model } : {}),
      ...(part.metadata ? { metadata: part.metadata } : {}),
    }
  }
  return undefined
}

export function createRewindRetryInput(input: { message: UserMessage; parts: Part[] }): RewindRetryInput | undefined {
  const { message } = input
  if (message.isRoot === false || message.includeInContext === false) return undefined
  if (message.origin && message.origin.type !== "user") return undefined

  const parts = input.parts.flatMap((part) => {
    const retry = retryPart(part)
    return retry ? [retry] : []
  })
  if (parts.length === 0) return undefined

  return {
    sessionID: message.sessionID,
    agent: message.agent,
    model: message.model,
    parts,
    metadata: message.metadata,
    summary: message.summary?.title ? { title: message.summary.title } : undefined,
    tools: message.tools,
    system: message.system,
    variant: message.variant,
  }
}
