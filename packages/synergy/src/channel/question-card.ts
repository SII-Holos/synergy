import type { Question } from "@/question"
import { ScopedState } from "@/scope/scoped-state"
import { Lock } from "@/util/lock"
import { Log } from "@/util/log"
import {
  QuestionCardCallback,
  type Provider,
  type QuestionCardActionResult,
  type QuestionCardCallback as QuestionCardCallbackType,
} from "./types"

type Registration = {
  status: "pending" | "active"
  requestId: string
  sessionID: string
  channelType: string
  accountId: string
  chatId: string
  requesterId: string
  questions: Question.Info[]
  provider?: Provider
  messageId?: string
}

const MAX_ACCEPTED_CALLBACKS = 256

const state = ScopedState.create(() => ({
  registrations: new Map<string, Registration>(),
  accepted: new Map<string, { eventId: string; sessionID: string }>(),
}))
const log = Log.create({ service: "channel.question-card" })

function lockKey(requestId: string): string {
  return `channel-question-card:${requestId}`
}

function rememberAccepted(input: { requestId: string; eventId: string; sessionID: string }): void {
  const accepted = state().accepted
  accepted.delete(input.requestId)
  accepted.set(input.requestId, { eventId: input.eventId, sessionID: input.sessionID })
  while (accepted.size > MAX_ACCEPTED_CALLBACKS) {
    const oldest = accepted.keys().next().value
    if (!oldest) break
    accepted.delete(oldest)
  }
}

export namespace QuestionCardRuntime {
  export async function deliver(input: {
    provider: Provider
    accountId: string
    chatId: string
    chatType?: "dm" | "group"
    scopeKey?: string
    replyToMessageId?: string
    requesterId: string
    sessionID: string
    request: Question.Request
  }): Promise<boolean> {
    if (!input.provider.sendQuestionCard || input.request.sessionID !== input.sessionID) return false

    const registration: Registration = {
      status: "pending",
      requestId: input.request.id,
      sessionID: input.sessionID,
      channelType: input.provider.type,
      accountId: input.accountId,
      chatId: input.chatId,
      requesterId: input.requesterId,
      questions: input.request.questions,
      provider: input.provider,
    }
    {
      using _ = await Lock.write(lockKey(input.request.id))
      const registrations = state().registrations
      if (registrations.has(input.request.id)) return true
      registrations.set(input.request.id, registration)
    }

    try {
      const sent = await input.provider.sendQuestionCard({
        accountId: input.accountId,
        chatId: input.chatId,
        ...(input.chatType ? { chatType: input.chatType } : {}),
        ...(input.scopeKey ? { scopeKey: input.scopeKey } : {}),
        replyToMessageId: input.replyToMessageId,
        requestId: input.request.id,
        questions: input.request.questions,
      })
      if (!sent.messageId.trim()) throw new Error("Question card provider returned no message ID")

      using _ = await Lock.write(lockKey(input.request.id))
      if (state().registrations.get(input.request.id) !== registration) return false
      registration.status = "active"
      registration.messageId = sent.messageId
      return true
    } catch (error) {
      let rejectQuestion = false
      {
        using _ = await Lock.write(lockKey(input.request.id))
        const registrations = state().registrations
        if (registrations.get(input.request.id) === registration) {
          registrations.delete(input.request.id)
          rejectQuestion = true
        }
      }
      if (rejectQuestion) {
        const { Question } = await import("@/question")
        await Question.reject(input.request.id)
      }
      log.warn("question card delivery failed", {
        requestId: input.request.id,
        sessionID: input.sessionID,
        error,
      })
      return false
    }
  }

  export async function acceptAction(input: {
    channelType: string
    accountId: string
    callback: QuestionCardCallbackType
  }): Promise<QuestionCardActionResult> {
    const parsed = QuestionCardCallback.safeParse(input.callback)
    if (!parsed.success) return { status: "rejected" }
    const callback = parsed.data

    using _ = await Lock.write(lockKey(callback.requestId))
    const runtime = state()
    const registration = runtime.registrations.get(callback.requestId)
    if (!registration) {
      const status = runtime.accepted.get(callback.requestId)?.eventId === callback.eventId ? "duplicate" : "expired"
      log.info("question card callback not accepted", { requestId: callback.requestId, status })
      return { status }
    }
    if (registration.status !== "active") {
      log.info("question card callback rejected", { requestId: callback.requestId, reason: "registration not active" })
      return { status: "rejected" }
    }
    if (!matchesOwner(registration, input, callback)) {
      log.info("question card callback rejected", { requestId: callback.requestId, reason: "owner mismatch" })
      return { status: "rejected" }
    }

    const answers = resolveAnswers(registration.questions, callback)
    if (!answers) {
      log.info("question card callback rejected", { requestId: callback.requestId, reason: "invalid answers" })
      return { status: "rejected" }
    }

    const { Question } = await import("@/question")
    const replied = await Question.tryReply({ requestID: callback.requestId, answers })
    if (!replied) {
      runtime.registrations.delete(callback.requestId)
      log.info("question card callback not accepted", {
        requestId: callback.requestId,
        status: "expired",
        reason: "question no longer pending",
      })
      return { status: "expired" }
    }
    runtime.registrations.delete(callback.requestId)
    rememberAccepted({ requestId: callback.requestId, eventId: callback.eventId, sessionID: registration.sessionID })
    const summary = registration.provider?.renderQuestionCardSummary?.({
      questions: registration.questions,
      answers,
    })
    return summary ? { status: "accepted", card: summary } : { status: "accepted" }
  }

  export async function settle(requestId: string): Promise<void> {
    using _ = await Lock.write(lockKey(requestId))
    state().registrations.delete(requestId)
  }

  export async function clearSession(sessionID: string): Promise<void> {
    const runtime = state()
    const requestIds = new Set<string>()
    for (const [requestId, registration] of runtime.registrations) {
      if (registration.sessionID === sessionID) requestIds.add(requestId)
    }
    for (const [requestId, accepted] of runtime.accepted) {
      if (accepted.sessionID === sessionID) requestIds.add(requestId)
    }

    await Promise.all(
      Array.from(requestIds, async (requestId) => {
        using _ = await Lock.write(lockKey(requestId))
        const current = state()
        if (current.registrations.get(requestId)?.sessionID === sessionID) {
          current.registrations.delete(requestId)
        }
        if (current.accepted.get(requestId)?.sessionID === sessionID) {
          current.accepted.delete(requestId)
        }
      }),
    )
  }

  export function hasRegistration(requestId: string): boolean {
    return state().registrations.has(requestId)
  }

  function matchesOwner(
    registration: Registration,
    input: { channelType: string; accountId: string },
    callback: QuestionCardCallbackType,
  ): boolean {
    return (
      registration.channelType === input.channelType &&
      registration.accountId === input.accountId &&
      registration.chatId === callback.chatId &&
      registration.requesterId === callback.requesterId &&
      registration.messageId === callback.messageId
    )
  }

  function resolveAnswers(
    questions: Question.Info[],
    callback: QuestionCardCallbackType,
  ): Question.Answer[] | undefined {
    if (callback.formValues.length !== questions.length) return undefined
    const values = new Map(callback.formValues.map((value) => [value.name, value]))
    if (values.size !== callback.formValues.length) return undefined

    const answers: Question.Answer[] = []
    for (const [questionIndex, question] of questions.entries()) {
      const value = values.get(`question_${questionIndex}`)
      if (!value) return undefined
      if (!question.multiple && value.selected.length > 1) return undefined

      const labels: string[] = []
      const seenIndices = new Set<number>()
      for (const encoded of value.selected) {
        const optionIndex = Number(encoded)
        if (!Number.isSafeInteger(optionIndex) || optionIndex < 0 || optionIndex >= question.options.length) {
          return undefined
        }
        if (seenIndices.has(optionIndex)) return undefined
        seenIndices.add(optionIndex)
        labels.push(question.options[optionIndex].label)
      }

      const custom = value.custom?.trim()
      const answer = question.multiple
        ? [...labels, ...(custom && !labels.includes(custom) ? [custom] : [])]
        : custom
          ? [custom]
          : labels
      if (answer.length === 0) return undefined
      answers.push(answer)
    }
    return answers
  }
}
