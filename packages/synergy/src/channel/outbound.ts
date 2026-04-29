import { Bus } from "@/bus"
import { Log } from "@/util/log"
import { MessageV2 } from "@/session/message-v2"
import { SessionManager } from "@/session/manager"
import { SessionEndpoint } from "@/session/endpoint"
import { Session } from "@/session"
import { Channel } from "."

const log = Log.create({ service: "channel.outbound" })

const INTERNAL_CHANNEL_TYPES = new Set(["app", "genesis"])

export namespace ChannelOutbound {
  let unsubscribe: (() => void) | null = null

  export function init(): () => void {
    if (unsubscribe) return unsubscribe

    unsubscribe = Bus.subscribe(MessageV2.Event.Updated, async (event) => {
      const msg = event.properties.info
      if (msg.role !== "assistant") return

      const assistant = msg as MessageV2.Assistant
      if (!assistant.time.completed) return

      const metadata = (assistant.metadata ?? undefined) as Record<string, unknown> | undefined
      if (!metadata?.mailbox && !metadata?.channelPush) return

      if (metadata.channelOutboundSent) return

      const session = await SessionManager.getSession(msg.sessionID).catch(() => undefined)
      if (!session?.endpoint) return
      if (session.endpoint.kind !== "channel") return

      const channelInfo = session.endpoint.channel
      if (INTERNAL_CHANNEL_TYPES.has(channelInfo.type)) return
      if (!channelInfo.accountId || !channelInfo.chatId) return

      const provider = Channel.getProvider(channelInfo.type)
      if (!provider) {
        log.warn("no provider for channel type", { type: channelInfo.type, sessionID: msg.sessionID })
        return
      }

      const parts = await MessageV2.parts({ sessionID: msg.sessionID, messageID: msg.id }).catch(() => [])
      const text = MessageV2.extractText(parts, { includeSynthetic: false })
      if (!text) return

      try {
        await provider.pushMessage({
          accountId: channelInfo.accountId,
          chatId: channelInfo.chatId,
          parts: [{ type: "text", text }],
        })

        await Session.updateMessage({
          ...assistant,
          metadata: {
            ...(metadata ?? {}),
            channelOutboundSent: true,
          },
        })

        log.info("message pushed to channel", {
          sessionID: msg.sessionID,
          channelType: channelInfo.type,
          accountId: channelInfo.accountId,
          chatId: channelInfo.chatId,
        })
      } catch (err) {
        log.error("channel outbound push failed", {
          sessionID: msg.sessionID,
          channelType: channelInfo.type,
          chatId: channelInfo.chatId,
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
