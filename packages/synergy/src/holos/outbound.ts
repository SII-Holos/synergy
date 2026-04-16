import { Bus } from "@/bus"
import { Log } from "@/util/log"
import { MessageV2 } from "@/session/message-v2"
import { Session } from "@/session"
import { SessionEndpoint } from "@/session/endpoint"
import { SessionManager } from "@/session/manager"
import { HolosRuntime } from "./runtime"
import { HolosMessageMetadata } from "./message-metadata"
import type { HolosProtocol } from "./protocol"

const log = Log.create({ service: "holos.outbound" })

export namespace HolosOutbound {
  let unsubscribe: (() => void) | null = null

  export function init(): () => void {
    if (unsubscribe) return unsubscribe
    unsubscribe = Bus.subscribe(MessageV2.Event.Updated, async (event) => {
      const msg = event.properties.info
      log.debug("[outbound] message.updated event", { messageID: msg.id, role: msg.role, sessionID: msg.sessionID })
      if (msg.role !== "assistant") return
      const assistant = msg as MessageV2.Assistant

      if (!assistant.time.completed) return

      const metadata = (assistant.metadata as Record<string, unknown> | undefined) ?? undefined
      const holosMetadata = HolosMessageMetadata.holos(metadata)

      if (holosMetadata?.messageId) {
        log.debug("[outbound] skipping: already sent", { messageID: msg.id })
        return
      }

      const session = await SessionManager.getSession(msg.sessionID).catch(() => undefined)
      if (!SessionEndpoint.isHolos(session?.endpoint)) return

      if (holosMetadata?.inbound) return

      const provider = await HolosRuntime.getProvider()
      if (!provider) return

      const contactId = session.endpoint.agentId
      const parts = await MessageV2.parts({ sessionID: msg.sessionID, messageID: msg.id }).catch(() => [])
      const text = MessageV2.extractText(parts, { includeSynthetic: false })
      if (!text) return

      const source = (assistant.metadata?.source ?? "agent") as HolosProtocol.ChatMessagePayload["source"]
      const replyToMessageId = holosMetadata?.replyToMessageId

      try {
        const result = await provider.sendChatMessage(contactId, text, { source, replyToMessageId })
        await Session.updateMessage({
          ...assistant,
          metadata: HolosMessageMetadata.merge(assistant.metadata ?? undefined, {
            holos: {
              ...(holosMetadata ?? {}),
              messageId: result.messageId,
            },
          }),
        })
        log.info("[outbound] message sent", { sessionID: msg.sessionID, contactId, source })
      } catch (err) {
        log.error("[outbound] message FAILED", { sessionID: msg.sessionID, contactId, error: err })
      }
    })
    return () => {
      unsubscribe?.()
      unsubscribe = null
    }
  }
}
