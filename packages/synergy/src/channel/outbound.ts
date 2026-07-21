import { Bus } from "@/bus"
import { Log } from "@/util/log"
import { Lock } from "@/util/lock"
import { MessageV2 } from "@/session/message-v2"
import { SessionManager } from "@/session/manager"
import { SessionProgress } from "@/session/progress"
import { Session } from "@/session"
import { Channel } from "."
import { externalIdentityHash } from "./identity"

const log = Log.create({ service: "channel.outbound" })

const INTERNAL_CHANNEL_TYPES = new Set(["app"])

export namespace ChannelOutbound {
  let unsubscribe: (() => void) | null = null

  export function init(): () => void {
    if (unsubscribe) return unsubscribe

    unsubscribe = Bus.subscribe(MessageV2.Event.Updated, async (event) => {
      const msg = event.properties.info
      if (msg.role !== "assistant") return

      const assistant = msg as MessageV2.Assistant
      if (!assistant.time.completed || !SessionProgress.isTerminalAssistant(assistant)) return

      const eventMetadata = assistant.metadata
      if (!eventMetadata?.mailbox && !eventMetadata?.channelPush && !eventMetadata?.channelReply) return
      if (eventMetadata.channelOutboundSent) return

      using _ = await Lock.write(`channel-outbound:${msg.id}`)
      const current = await MessageV2.get({ sessionID: msg.sessionID, messageID: msg.id }).catch(() => undefined)
      if (!current || current.info.role !== "assistant") return

      const currentAssistant = current.info as MessageV2.Assistant
      const metadata = currentAssistant.metadata
      if (!currentAssistant.time.completed || !SessionProgress.isTerminalAssistant(currentAssistant)) return
      if (!metadata?.mailbox && !metadata?.channelPush && !metadata?.channelReply) return
      if (metadata.channelOutboundSent) return

      const session = await SessionManager.getSession(msg.sessionID).catch(() => undefined)
      if (!session?.endpoint || session.endpoint.kind !== "channel") return

      const channelInfo = session.endpoint.channel
      if (INTERNAL_CHANNEL_TYPES.has(channelInfo.type)) return
      if (!channelInfo.accountId) return

      const replyRequired = metadata.channelReply === true
      const replyToMessageId =
        typeof metadata.channelReplyToMessageId === "string" && metadata.channelReplyToMessageId.trim()
          ? metadata.channelReplyToMessageId
          : undefined
      if (replyRequired && !replyToMessageId) {
        log.warn("channel reply skipped without message anchor", {
          sessionID: msg.sessionID,
          channelType: channelInfo.type,
        })
        return
      }
      if (!replyRequired && !channelInfo.chatId) return

      const provider = Channel.getProvider(channelInfo.type)
      if (!provider) {
        log.warn("no provider for channel type", { type: channelInfo.type, sessionID: msg.sessionID })
        return
      }

      const text = MessageV2.extractText(current.parts, { includeSynthetic: false })
      if (!text) return

      try {
        if (replyRequired && replyToMessageId) {
          await provider.replyMessage({
            accountId: channelInfo.accountId,
            messageId: replyToMessageId,
            parts: [{ type: "text", text }],
          })
        } else {
          await provider.pushMessage({
            accountId: channelInfo.accountId,
            chatId: channelInfo.chatId,
            parts: [{ type: "text", text }],
          })
        }

        await Session.mergeMessageMetadata({
          sessionID: msg.sessionID,
          messageID: msg.id,
          metadata: { channelOutboundSent: true },
        })

        log.info(replyRequired ? "message replied to channel" : "message pushed to channel", {
          sessionID: msg.sessionID,
          channelType: channelInfo.type,
          accountHash: externalIdentityHash(channelInfo.accountId),
          chatHash: externalIdentityHash(channelInfo.chatId),
        })
      } catch (err) {
        log.error(replyRequired ? "channel outbound reply failed" : "channel outbound push failed", {
          sessionID: msg.sessionID,
          channelType: channelInfo.type,
          chatHash: externalIdentityHash(channelInfo.chatId),
          error: err,
        })
      }
    })

    log.info("channel outbound bridge initialized")
    return () => {
      unsubscribe?.()
      unsubscribe = null
    }
  }
}
