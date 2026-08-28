import { Bus } from "@/bus"
import { ScopedState } from "@/scope/scoped-state"
import { Log } from "@/util/log"
import { Lock } from "@/util/lock"
import { MessageV2 } from "@/session/message-v2"
import { SessionManager } from "@/session/manager"
import { SessionProgress } from "@/session/progress"
import { Session } from "@/session"
import { externalIdentityHash } from "../util/identity"
import {
  loadChannelTaskMessages,
  markChannelTaskAttachmentsDelivered,
  projectChannelTaskPartsWithUrls,
} from "./outbound-parts"
import { ResponseCardRuntime } from "./response-card"
import type { Provider } from "./types"

const log = Log.create({ service: "channel.outbound" })

const INTERNAL_CHANNEL_TYPES = new Set(["app"])

const foregroundSessions = new Set<string>()

export namespace ChannelOutbound {
  const state = ScopedState.create(
    () => ({ unsubscribe: undefined as (() => void) | undefined }),
    async (entry) => {
      entry.unsubscribe?.()
      entry.unsubscribe = undefined
    },
  )

  /**
   * Register a Channel Session root whose foreground streaming card owns the
   * terminal reply. While registered, the outbound bridge skips that root's
   * terminal assistant messages so the answer is not delivered twice. Call
   * before the generation loop and unregister after the streaming card closes.
   * A crash loses the registry and the durable channelOutboundSent flag, so
   * queued or recovered replies still reach the bridge.
   */
  export function beginForeground(sessionID: string, rootID: string): void {
    foregroundSessions.add(`${sessionID}:${rootID}`)
  }

  export function endForeground(sessionID: string, rootID: string): void {
    foregroundSessions.delete(`${sessionID}:${rootID}`)
  }

  export function isForeground(sessionID: string, rootID: string | undefined): boolean {
    if (!rootID) return false
    return foregroundSessions.has(`${sessionID}:${rootID}`)
  }

  export function init(input: { getProvider: (type: string) => Provider | undefined }): () => void {
    const bridge = state()
    if (!bridge.unsubscribe) {
      // Cross-scope subscription: channel sessions may execute in per-thread
      // checkout scopes (e.g. GitHub), where the terminal assistant message
      // is published on that scope's Bus. The scoped Bus would hide the event
      // from this bridge, so observe it globally.
      bridge.unsubscribe = Bus.subscribeGlobal(MessageV2.Event.Updated, async (event) => {
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
        if (ChannelOutbound.isForeground(msg.sessionID, currentAssistant.rootID ?? currentAssistant.parentID)) {
          log.debug("skipping foreground-delivered channel reply", { sessionID: msg.sessionID, messageID: msg.id })
          return
        }

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
        const chatId = channelInfo.chatId
        if (!replyRequired && !chatId) return

        const provider = input.getProvider(channelInfo.type)
        if (!provider) {
          log.warn("no provider for channel type", { type: channelInfo.type, sessionID: msg.sessionID })
          return
        }

        const rootID = currentAssistant.rootID ?? currentAssistant.parentID
        const messages = await loadChannelTaskMessages({
          sessionID: msg.sessionID,
          rootID,
          terminal: current,
        })
        const { parts, urls } = await projectChannelTaskPartsWithUrls({
          messages,
          rootID,
          terminalMessageID: currentAssistant.id,
          includeText: true,
        })

        try {
          const cardsHandled = await ResponseCardRuntime.deliverTaskCards({
            provider,
            accountId: channelInfo.accountId,
            chatId: chatId ?? "",
            chatType: channelInfo.chatType,
            scopeKey: channelInfo.scopeKey,
            replyToMessageId,
            sessionID: msg.sessionID,
            terminal: current,
            messages,
          })
          if (parts.length === 0 && !cardsHandled) return
          if (parts.length > 0) {
            const conversation = provider.conversation
            const replyMessage = conversation?.replyMessage?.bind(conversation) ?? provider.replyMessage?.bind(provider)
            const pushMessage = conversation?.pushMessage?.bind(conversation) ?? provider.pushMessage?.bind(provider)
            if (replyRequired && replyToMessageId) {
              if (!replyMessage) return
              await replyMessage({
                accountId: channelInfo.accountId,
                messageId: replyToMessageId,
                chatId,
                chatType: channelInfo.chatType,
                scopeKey: channelInfo.scopeKey,
                parts,
              })
            } else if (chatId) {
              if (!pushMessage) return
              await pushMessage({
                accountId: channelInfo.accountId,
                chatId,
                parts,
              })
            }
          }

          await markChannelTaskAttachmentsDelivered({
            sessionID: msg.sessionID,
            rootID,
            urls,
            messages,
          })

          await Session.mergeMessageMetadata({
            sessionID: msg.sessionID,
            messageID: msg.id,
            metadata: { channelOutboundSent: true },
          })

          log.info(replyRequired ? "message replied to channel" : "message pushed to channel", {
            sessionID: msg.sessionID,
            channelType: channelInfo.type,
            accountHash: externalIdentityHash(channelInfo.accountId),
            chatHash: chatId ? externalIdentityHash(chatId) : undefined,
          })
        } catch (err) {
          log.error(replyRequired ? "channel outbound reply failed" : "channel outbound push failed", {
            sessionID: msg.sessionID,
            channelType: channelInfo.type,
            chatHash: chatId ? externalIdentityHash(chatId) : undefined,
            error: err,
          })
        }
      })
      log.info("channel outbound bridge initialized")
    }

    const unsubscribe = bridge.unsubscribe
    return () => {
      if (bridge.unsubscribe !== unsubscribe) return
      unsubscribe()
      bridge.unsubscribe = undefined
    }
  }
}
