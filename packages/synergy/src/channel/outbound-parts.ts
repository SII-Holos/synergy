import path from "path"
import { Asset } from "@/asset/asset"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session"
import { Log } from "@/util/log"
import type { OutboundPart, Provider } from "./types"

const log = Log.create({ service: "channel.outbound-parts" })

const MAX_CHANNEL_ATTACHMENT_BYTES = 25 * 1024 * 1024

const CHANNEL_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/x-icon",
  "image/tiff",
  "image/heic",
])

type ProjectInput = {
  messages: MessageV2.WithParts[]
  rootID: string
  terminalMessageID: string
  includeText: boolean
}

export async function projectChannelTaskParts(input: ProjectInput): Promise<OutboundPart[]> {
  const messages = input.messages.filter(
    (message) => message.info.role === "assistant" && message.info.rootID === input.rootID,
  )
  const result: OutboundPart[] = []
  const terminal = messages.find((message) => message.info.id === input.terminalMessageID)
  if (input.includeText && terminal) {
    const text = MessageV2.extractText(terminal.parts, { includeSynthetic: false })
    if (text) result.push({ type: "text", text })
  }

  const seen = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.state.status !== "completed") continue
      for (const attachment of part.state.attachments ?? []) {
        if (attachment.presentation?.hidden) continue
        if (!MessageV2.isDeliverableAttachment(attachment)) continue
        if (seen.has(attachment.url)) continue
        seen.add(attachment.url)
        const outbound = await projectAttachment(attachment)
        if (outbound) result.push(outbound)
      }
    }
  }
  return result
}

export async function loadChannelTaskMessages(input: {
  sessionID: string
  rootID: string
  terminal: MessageV2.WithParts
}): Promise<MessageV2.WithParts[]> {
  const messages = await Session.messages({ sessionID: input.sessionID })
  const hydrated = messages.map((message) => (message.info.id === input.terminal.info.id ? input.terminal : message))
  return MessageV2.deriveSemantics(hydrated)
}

export async function replyChannelTaskAttachments(input: {
  provider: Provider
  accountId: string
  messageId: string
  sessionID: string
  terminal: MessageV2.WithParts
  messages?: MessageV2.WithParts[]
}): Promise<boolean> {
  if (input.terminal.info.role !== "assistant") return false
  const rootID = input.terminal.info.rootID ?? input.terminal.info.parentID
  const messages =
    input.messages ??
    (await loadChannelTaskMessages({
      sessionID: input.sessionID,
      rootID,
      terminal: input.terminal,
    }))
  const parts = await projectChannelTaskParts({
    messages,
    rootID,
    terminalMessageID: input.terminal.info.id,
    includeText: false,
  })
  if (parts.length === 0) return false
  const conversation = input.provider.conversation
  const replyMessage =
    conversation?.replyMessage?.bind(conversation) ?? input.provider.replyMessage?.bind(input.provider)
  if (!replyMessage) return false
  await replyMessage({
    accountId: input.accountId,
    messageId: input.messageId,
    parts,
  })
  return true
}

async function projectAttachment(attachment: MessageV2.AttachmentPart): Promise<OutboundPart | undefined> {
  const source = await resolveAttachmentSource(attachment)
  if (!source) return undefined
  return {
    type: outboundType(attachment.mime),
    ...source,
    filename: attachment.filename ?? inferFilename(attachment),
    contentType: attachment.mime || undefined,
  }
}

async function resolveAttachmentSource(attachment: MessageV2.AttachmentPart): Promise<{ path: string } | undefined> {
  if (!attachment.url.startsWith("asset://")) {
    log.warn("channel attachment must use the asset store", {
      attachmentID: attachment.id,
      filename: attachment.filename,
    })
    return undefined
  }

  const assetID = assetIDFromUrl(attachment.url)
  const assetPath = assetID ? Asset.resolvePath(assetID) : undefined
  if (!assetPath) {
    log.warn("channel attachment asset is unavailable", {
      attachmentID: attachment.id,
      filename: attachment.filename,
    })
    return undefined
  }

  const file = Bun.file(assetPath)
  if (!(await file.exists())) {
    log.warn("channel attachment asset is unavailable", {
      attachmentID: attachment.id,
      filename: attachment.filename,
    })
    return undefined
  }
  if (file.size > MAX_CHANNEL_ATTACHMENT_BYTES) {
    log.warn("channel attachment exceeds the delivery size limit", {
      attachmentID: attachment.id,
      filename: attachment.filename,
      size: file.size,
      limit: MAX_CHANNEL_ATTACHMENT_BYTES,
    })
    return undefined
  }
  return { path: assetPath }
}

function assetIDFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.pathname}` || undefined
  } catch {
    return undefined
  }
}

function outboundType(mime: string): Exclude<OutboundPart["type"], "text"> {
  if (CHANNEL_IMAGE_MIME_TYPES.has(mime)) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  return "file"
}

function inferFilename(attachment: MessageV2.AttachmentPart): string {
  if (attachment.localPath) return path.basename(attachment.localPath)
  try {
    return path.basename(new URL(attachment.url).pathname) || "attachment"
  } catch {
    return "attachment"
  }
}
