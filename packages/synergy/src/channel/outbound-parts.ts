import path from "path"
import { Asset } from "@/asset/asset"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session"
import { SessionProgress } from "@/session/progress"
import { Log } from "@/util/log"
import { Lock } from "@/util/lock"
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

/**
 * Root-scoped record of attachment urls already delivered to the channel for
 * this task tree. Stored on the root user message so re-projecting the same
 * tree after a later terminal reply (steer wake-ups, boss reports, agenda)
 * skips attachments that were already sent. A new task = a new root, so the
 * record starts empty and attachments can be delivered again on purpose.
 */
const CHANNEL_OUTBOUND_ATTACHMENT_URLS = "channelOutboundAttachmentUrls"

export async function projectChannelTaskParts(input: ProjectInput): Promise<OutboundPart[]> {
  return (await projectChannelTaskPartsWithUrls(input)).parts
}

export async function projectChannelTaskPartsWithUrls(input: ProjectInput): Promise<{
  parts: OutboundPart[]
  urls: string[]
}> {
  const messages = input.messages.filter(
    (message) => message.info.role === "assistant" && message.info.rootID === input.rootID,
  )
  const result: OutboundPart[] = []
  const terminal = messages.find((message) => message.info.id === input.terminalMessageID)
  if (input.includeText && terminal) {
    const text = MessageV2.extractText(terminal.parts, { includeSynthetic: false })
    if (text) result.push({ type: "text", text })
  }

  const delivered = deliveredAttachmentUrls(input.messages, input.rootID)
  const seen = new Set<string>()
  const urls: string[] = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.state.status !== "completed") continue
      for (const attachment of part.state.attachments ?? []) {
        if (attachment.presentation?.hidden) continue
        if (!MessageV2.isDeliverableAttachment(attachment)) continue
        if (delivered.has(attachment.url)) continue
        if (seen.has(attachment.url)) continue
        seen.add(attachment.url)
        const outbound = await projectAttachment(attachment)
        if (outbound) {
          result.push(outbound)
          urls.push(attachment.url)
        }
      }
    }
  }
  return { parts: result, urls }
}

/**
 * Record the attachment urls actually delivered for a task tree on its root
 * user message. Called after a successful channel send so a later re-projection
 * of the same tree skips them; a failed send never records, so the next attempt
 * re-delivers. Missing root (e.g. synthetic test trees) is tolerated.
 */
export async function markChannelTaskAttachmentsDelivered(input: {
  sessionID: string
  rootID: string
  urls: string[]
  messages: MessageV2.WithParts[]
}): Promise<void> {
  if (input.urls.length === 0) return
  const root = input.messages.find(
    (message) =>
      message.info.role === "user" && (message.info.id === input.rootID || message.info.rootID === input.rootID),
  )
  if (!root) {
    log.warn("channel task root missing for delivery record", {
      sessionID: input.sessionID,
      rootID: input.rootID,
    })
    return
  }
  try {
    using _ = await Lock.write(`channel-outbound-attachments:${input.sessionID}:${input.rootID}`)
    const current = await MessageV2.get({ sessionID: input.sessionID, messageID: root.info.id }).catch(() => undefined)
    const existing = current?.info.metadata?.[CHANNEL_OUTBOUND_ATTACHMENT_URLS]
    const merged = Array.from(new Set([...(Array.isArray(existing) ? existing : []), ...input.urls]))
    await Session.mergeMessageMetadata({
      sessionID: input.sessionID,
      messageID: root.info.id,
      metadata: { [CHANNEL_OUTBOUND_ATTACHMENT_URLS]: merged },
    })
  } catch (err) {
    log.warn("failed to record channel attachment delivery", { sessionID: input.sessionID, error: err })
  }
}

function deliveredAttachmentUrls(messages: MessageV2.WithParts[], rootID: string): Set<string> {
  const root = messages.find(
    (message) => message.info.role === "user" && (message.info.id === rootID || message.info.rootID === rootID),
  )
  const urls = root?.info.metadata?.[CHANNEL_OUTBOUND_ATTACHMENT_URLS]
  return new Set(Array.isArray(urls) ? urls : [])
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

/**
 * Collect every terminal assistant message currently present in a session,
 * keyed by its root user message id. The foreground delivery path snapshots
 * this before invoking the inbox loop and again after: roots that gained a
 * terminal during the invoke were completed by this foreground turn (the loop
 * drains queued tasks too) and must each be delivered, not just the final
 * result. Otherwise a terminal completed mid-drain is skipped by the bridge
 * (foreground registered) yet never delivered by the foreground path.
 */
export async function collectChannelTaskTerminals(sessionID: string): Promise<Map<string, MessageV2.WithParts>> {
  const messages = await Session.messages({ sessionID })
  const terminals = new Map<string, MessageV2.WithParts>()
  for (const message of MessageV2.deriveSemantics(messages)) {
    if (message.info.role !== "assistant") continue
    const assistant = message.info as MessageV2.Assistant
    if (!SessionProgress.isTerminalAssistant(assistant)) continue
    const rootID = assistant.rootID ?? assistant.parentID
    if (rootID) terminals.set(rootID, message)
  }
  return terminals
}

/**
 * Deliver a terminal that the foreground invoke completed but did not return.
 * The inbox loop drains queued tasks and returns the LAST terminal; the root
 * that owns this foreground lane may have finished earlier (mid-drain). The
 * outbound bridge skipped it because the root is foreground-registered, so it
 * must be delivered here: text + attachments via the provider reply, recorded
 * as delivered on the root and marked sent on the terminal. Skips when the
 * terminal already existed before the invoke (delivered elsewhere) or is the
 * loop result (delivered by the normal foreground path).
 */
export async function deliverForegroundTaskTerminal(input: {
  provider: Provider
  accountId: string
  messageId: string
  chatId?: string
  chatType?: "dm" | "group"
  scopeKey?: string
  sessionID: string
  currentRootID: string
  excludeTerminalID?: string
  terminalsBefore: ReadonlyMap<string, MessageV2.WithParts>
}): Promise<boolean> {
  const terminalsAfter = await collectChannelTaskTerminals(input.sessionID)
  const terminal = terminalsAfter.get(input.currentRootID)
  if (!terminal) return false
  if (terminal.info.id === input.excludeTerminalID) return false
  if (input.terminalsBefore.get(input.currentRootID)?.info.id === terminal.info.id) return false

  const messages = await loadChannelTaskMessages({
    sessionID: input.sessionID,
    rootID: input.currentRootID,
    terminal,
  })
  const { parts, urls } = await projectChannelTaskPartsWithUrls({
    messages,
    rootID: input.currentRootID,
    terminalMessageID: terminal.info.id,
    includeText: true,
  })
  if (parts.length === 0) return false
  const conversation = input.provider.conversation
  const replyMessage =
    conversation?.replyMessage?.bind(conversation) ?? input.provider.replyMessage?.bind(input.provider)
  if (!replyMessage) return false
  await replyMessage({
    accountId: input.accountId,
    messageId: input.messageId,
    chatId: input.chatId,
    chatType: input.chatType,
    scopeKey: input.scopeKey,
    parts,
  })
  await markChannelTaskAttachmentsDelivered({
    sessionID: input.sessionID,
    rootID: input.currentRootID,
    urls,
    messages,
  })
  await Session.mergeMessageMetadata({
    sessionID: input.sessionID,
    messageID: terminal.info.id,
    metadata: { channelOutboundSent: true },
  }).catch((err) => log.warn("failed to mark foreground terminal as sent", { sessionID: input.sessionID, error: err }))
  return true
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
  const { parts, urls } = await projectChannelTaskPartsWithUrls({
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
  await markChannelTaskAttachmentsDelivered({
    sessionID: input.sessionID,
    rootID,
    urls,
    messages,
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
