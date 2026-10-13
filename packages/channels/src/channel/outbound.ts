import { allowsAutomaticChannelDelivery } from "./routing"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { ScopedState } from "@ericsanchezok/synergy-harness/scope/scoped-state"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { Lock } from "@ericsanchezok/synergy-harness/util/lock"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { SessionManager } from "@ericsanchezok/synergy-harness/session/manager"
import { SessionProgress } from "@ericsanchezok/synergy-harness/session/progress"
import { SessionHistory } from "@ericsanchezok/synergy-harness/session/history"
import { externalIdentityHash } from "@ericsanchezok/synergy-harness/util/identity"
import { loadChannelDeliveryPlans } from "./delivery-plan"
import { executeChannelDeliveryPlan } from "./delivery"
import { reactionOnlyResolved } from "./reaction-only-runtime"
import type { Provider } from "./types"

const log = Log.create({ service: "channel.outbound" })

const INTERNAL_CHANNEL_TYPES = new Set(["app"])

const runtimeState = RuntimeContext.state(() => ({
  foregroundSessions: new Set<string>(),
}))

export namespace ChannelOutbound {
  const state = ScopedState.create(
    () => ({ unsubscribe: undefined as (() => void) | undefined, abort: undefined as AbortController | undefined }),
    async (entry) => {
      entry.abort?.abort()
      entry.unsubscribe?.()
      entry.unsubscribe = undefined
      entry.abort = undefined
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
    const instanceState = runtimeState()

    instanceState.foregroundSessions.add(`${sessionID}:${rootID}`)
  }

  export function endForeground(sessionID: string, rootID: string): void {
    const instanceState = runtimeState()

    instanceState.foregroundSessions.delete(`${sessionID}:${rootID}`)
  }

  export function isForeground(sessionID: string, rootID: string | undefined): boolean {
    const instanceState = runtimeState()

    if (!rootID) return false
    return instanceState.foregroundSessions.has(`${sessionID}:${rootID}`)
  }

  export function init(input: { getProvider: (type: string) => Provider | undefined }): () => void {
    const bridge = state()
    if (!bridge.unsubscribe) {
      const abort = new AbortController()
      bridge.abort = abort
      // Cross-scope subscription: channel sessions may execute in per-thread
      // checkout scopes (e.g. GitHub), where the terminal assistant message
      // is published on that scope's Bus. The scoped Bus would hide the event
      // from this bridge, so observe it globally.
      bridge.unsubscribe = Bus.subscribeGlobal(MessageV2.Event.Updated, async (event) => {
        if (abort.signal.aborted) return
        const msg = event.properties.info
        if (msg.role !== "assistant") return

        const assistant = msg as MessageV2.Assistant
        if (!assistant.time.completed || !SessionProgress.isTerminalAssistant(assistant)) return

        const eventMetadata = assistant.metadata
        if (!eventMetadata?.mailbox && !eventMetadata?.channelPush && !eventMetadata?.channelReply) return
        // A resolved reaction-only turn is terminal for this bridge even if it
        // never carried `channelOutboundSent`: the failure merge would
        // re-publish Updated, and without this guard the re-entered handler
        // re-acquires the same non-reentrant Lock.write key while its holder is
        // still awaiting the merge publish — a self-deadlock.
        if (eventMetadata.channelOutboundSent || reactionOnlyResolved(assistant)) return

        using _ = await Lock.write(`channel-outbound:${msg.id}`)
        const rootID = assistant.rootID ?? assistant.parentID
        const infos = await SessionHistory.turnInfos({ sessionID: msg.sessionID, rootID, signal: abort.signal }).catch(
          () => [],
        )
        const currentAssistant = infos.find((info) => info.id === msg.id)
        if (!currentAssistant || currentAssistant.role !== "assistant") return
        const metadata = currentAssistant.metadata
        if (!currentAssistant.time.completed || !SessionProgress.isTerminalAssistant(currentAssistant)) return
        if (!metadata?.mailbox && !metadata?.channelPush && !metadata?.channelReply) return
        if (metadata.channelOutboundSent || reactionOnlyResolved(currentAssistant)) return
        if (ChannelOutbound.isForeground(msg.sessionID, currentAssistant.rootID ?? currentAssistant.parentID)) {
          log.debug("skipping foreground-delivered channel reply", { sessionID: msg.sessionID, messageID: msg.id })
          return
        }

        const session = await SessionManager.getSession(msg.sessionID).catch(() => undefined)
        if (!session?.endpoint || session.endpoint.kind !== "channel") return

        if (!allowsAutomaticChannelDelivery(session)) return

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

        try {
          const [plan] = await loadChannelDeliveryPlans({
            sessionID: msg.sessionID,
            rootID,
            terminalIDs: new Set([currentAssistant.id]),
            replyToMessageId,
            signal: abort.signal,
          })
          if (!plan) return
          const outcome = await executeChannelDeliveryPlan({
            sessionID: msg.sessionID,
            plan,
            provider,
            accountId: channelInfo.accountId,
            chatId,
            chatType: channelInfo.chatType,
            scopeKey: channelInfo.scopeKey,
            replyToMessageId,
            signal: abort.signal,
          })

          if (outcome.status !== "delivered") return
          log.info("channel terminal delivery completed", {
            kind: plan.kind,
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
      bridge.abort?.abort()
      unsubscribe()
      bridge.unsubscribe = undefined
      bridge.abort = undefined
    }
  }
}
