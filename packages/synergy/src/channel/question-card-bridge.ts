import { Bus } from "@/bus"
import { Question } from "@/question"
import { ScopedState } from "@/scope/scoped-state"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Log } from "@/util/log"
import { getProvider } from "./provider-registry"
import { QuestionCardRuntime } from "./question-card"

const log = Log.create({ service: "channel.question-card-bridge" })

type BridgeState = {
  dispose?: () => void
}

const state = ScopedState.create(
  (): BridgeState => ({}),
  async (current) => {
    current.dispose?.()
  },
)

export namespace QuestionCardBridge {
  export function init(): () => void {
    const current = state()
    if (current.dispose) return current.dispose

    const settle = (event: { properties: { requestID: string } }) => {
      void QuestionCardRuntime.settle(event.properties.requestID).catch((error) =>
        log.warn("question card settlement failed", { requestID: event.properties.requestID, error }),
      )
    }
    const unsubscribers = [
      Bus.subscribe(Question.Event.Asked, (event) => {
        void deliver(event.properties)
      }),
      Bus.subscribe(Question.Event.Replied, settle),
      Bus.subscribe(Question.Event.Rejected, settle),
      Bus.subscribe(Question.Event.TimedOut, settle),
    ]

    const dispose = () => {
      if (current.dispose !== dispose) return
      for (const unsubscribe of unsubscribers) unsubscribe()
      current.dispose = undefined
    }
    current.dispose = dispose
    return dispose
  }

  async function deliver(request: Question.Request): Promise<void> {
    try {
      const session = await Session.get(request.sessionID)
      if (session.endpoint?.kind !== "channel") return

      const channel = session.endpoint.channel
      if (!channel.accountId || !channel.chatId) return
      const provider = getProvider(channel.type)
      if (!provider?.sendQuestionCard) return

      const toolMessageID = request.tool?.messageID
      if (!toolMessageID) {
        await rejectWithoutBinding(request, channel.type)
        return
      }
      const owner = await MessageV2.get({ sessionID: request.sessionID, messageID: toolMessageID })
      if (owner.info.role !== "assistant") {
        await rejectWithoutBinding(request, channel.type)
        return
      }
      const rootID = owner.info.rootID ?? owner.info.parentID
      const root = await MessageV2.get({ sessionID: request.sessionID, messageID: rootID })
      if (root.info.role !== "user" || root.info.isRoot !== true) {
        await rejectWithoutBinding(request, channel.type)
        return
      }
      const replyToMessageId = normalize(root?.info.metadata?.channelReplyToMessageId)
      const requesterId = normalize(root?.info.metadata?.channelRequesterId)
      if (!replyToMessageId || !requesterId) {
        await rejectWithoutBinding(request, channel.type)
        return
      }
      const chatId = normalize(root?.info.metadata?.channelChatId) ?? channel.chatId

      await QuestionCardRuntime.deliver({
        provider,
        accountId: channel.accountId,
        chatId,
        chatType: channel.chatType,
        scopeKey: channel.scopeKey,
        replyToMessageId,
        requesterId,
        sessionID: request.sessionID,
        request,
      })
    } catch (error) {
      log.warn("question card bridge delivery failed", { sessionID: request.sessionID, requestID: request.id, error })
      await Question.reject(request.id).catch(() => {})
    }
  }

  async function rejectWithoutBinding(request: Question.Request, channelType: string): Promise<void> {
    log.warn("question card skipped without durable channel binding", {
      sessionID: request.sessionID,
      channelType,
    })
    await Question.reject(request.id)
  }

  function normalize(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined
  }
}
