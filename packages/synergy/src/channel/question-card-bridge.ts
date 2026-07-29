import { Bus } from "@/bus"
import { Question } from "@/question"
import { ScopedState } from "@/scope/scoped-state"
import { Session } from "@/session"
import { SessionProgress } from "@/session/progress"
import { Log } from "@/util/log"
import { Channel } from "."
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
      const provider = Channel.getProvider(channel.type)
      if (!provider?.sendQuestionCard) return

      const messages = await Session.messages({ sessionID: request.sessionID })
      const root = messages.findLast(
        (message) => message.info.role === "user" && SessionProgress.isReplyRequiredUser(message.info),
      )
      const replyToMessageId = normalize(root?.info.metadata?.channelReplyToMessageId)
      const requesterId = normalize(root?.info.metadata?.channelRequesterId)
      if (!replyToMessageId || !requesterId) {
        log.warn("question card skipped without durable channel binding", {
          sessionID: request.sessionID,
          channelType: channel.type,
        })
        await Question.reject(request.id)
        return
      }

      await QuestionCardRuntime.deliver({
        provider,
        accountId: channel.accountId,
        chatId: channel.chatId,
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

  function normalize(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined
  }
}
