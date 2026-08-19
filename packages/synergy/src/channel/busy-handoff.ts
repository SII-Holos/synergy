import path from "path"
import { Attachment } from "../attachment"
import { Log } from "../util/log"
import { BusyError } from "../session/error"
import { SessionInbox } from "../session/inbox"
import { InvokeInput } from "../session/invoke"
import { MessageContext } from "./types"

const log = Log.create({ service: "channel.busy-handoff" })

/**
 * Channel-owned busy handoff: when a message arrives for a Session that is
 * currently occupied by an active generation loop, the message must be
 * persisted into the SessionInbox with a stable delivery key instead of
 * surfacing as a generation failure. The queued task is later materialized and
 * replied to by the existing ChannelOutbound bridge.
 */
export namespace ChannelBusyHandoff {
  const DELIVERY_KEY_PREFIX = "channel"

  export type DeliveryResult =
    | { status: "queued"; itemID: string; messageID: string }
    | { status: "not-busy" }
    | { status: "duplicate"; itemID: string; messageID: string }
  /** Stable delivery key: channel type + account + remote message identity. */
  export function deliveryKeyForMessage(input: { channelType: string; accountId: string; messageId: string }): string {
    return `${DELIVERY_KEY_PREFIX}:${input.channelType}:${input.accountId}:${input.messageId}`
  }

  export function buildDurablePromptParts(input: {
    ctx: MessageContext
    sessionID: string
    messageID: string
  }): Promise<InvokeInput["parts"]> {
    const parts: InvokeInput["parts"] = []

    let textBody = input.ctx.text
    if (input.ctx.quotedContent) {
      textBody = `[Replying to: "${input.ctx.quotedContent}"]\n\n${textBody}`
    }
    if (input.ctx.chatType === "group" && input.ctx.senderName) {
      textBody = `${input.ctx.senderName}: ${textBody}`
    }
    parts.push({ type: "text", text: textBody })

    const attachments = input.ctx.attachments ?? []
    return Promise.all(
      attachments.map(async (attachment) => {
        const part = await Attachment.toPart({
          filepath: attachment.path,
          mime: attachment.contentType,
          filename: attachment.filename ?? path.basename(attachment.path) ?? "attachment",
          sessionID: input.sessionID,
          messageID: input.messageID,
        })
        // Images are materialized as data URLs; persist a stable local copy so
        // the model-visible "Local path:" text and look_at keep working after
        // the inbound temp file is cleaned up — chat parity.
        if (part.mime.startsWith("image/") && !part.localPath) {
          try {
            const localPath = await Attachment.saveDataPartLocally(part)
            return { ...part, localPath }
          } catch (error) {
            log.warn("failed to persist channel image locally; look_at path unavailable", { error })
          }
        }
        return part
      }),
    ).then((durable) => [...parts, ...durable])
  }

  /**
   * Deliver a busy-queued message into the SessionInbox. Only a canonical
   * BusyError is handled here; any other error is returned as "not-busy" so
   * the caller preserves its existing failure behavior.
   */
  export async function deliverBusyTaskToInbox(input: {
    error: unknown
    sessionID: string
    deliveryKey: string
    parts: InvokeInput["parts"]
    metadata: Record<string, unknown>
    agent?: string
    model?: { providerID: string; modelID: string }
    variant?: string
  }): Promise<DeliveryResult> {
    if (!(input.error instanceof BusyError)) return { status: "not-busy" }
    const result = await SessionInbox.deliverUnique({
      sessionID: input.sessionID,
      deliveryKey: input.deliveryKey,
      mode: "task",
      message: {
        origin: { type: "channel" as const, label: "Channel" },
        role: "user",
        parts: input.parts,
        visible: true,
        metadata: input.metadata,
        agent: input.agent,
        model: input.model,
        variant: input.variant,
      },
    })
    if (!result.created) return { status: "duplicate", itemID: result.itemID, messageID: result.messageID }
    return { status: "queued", itemID: result.itemID, messageID: result.messageID }
  }
}
