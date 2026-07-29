import { describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { ChannelInteraction } from "../../src/channel/interaction"
import { QuestionCardRuntime } from "../../src/channel/question-card"
import type { Provider, QuestionCardCallback } from "../../src/channel/types"
import { Question } from "../../src/question"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { tmpdir } from "../fixture/fixture"

const questions: Question.Info[] = [
  {
    question: "Which environment?",
    header: "Env",
    options: [
      { label: "Staging", description: "Staging server" },
      { label: "Production", description: "Production server" },
    ],
  },
]

function provider(
  type: string,
  opts?: {
    messageId?: string
    onSendQuestionCard?: Provider["sendQuestionCard"]
  },
): Provider {
  return {
    type,
    lifecycle: "self_connected",
    async connect() {},
    async replyMessage() {
      return { messageId: "reply_sent" }
    },
    async pushMessage() {
      return { messageId: "push_sent" }
    },
    async sendQuestionCard(input) {
      return (await opts?.onSendQuestionCard?.(input)) ?? { messageId: opts?.messageId ?? "om_question_card" }
    },
    async addReaction() {},
    createStreamingSession() {
      return {
        async start() {},
        async update() {},
        async updateToolProgress() {},
        async close() {},
        isActive: () => false,
      }
    },
  }
}

async function createChannelSession(type = "feishu") {
  return Session.create({
    endpoint: SessionEndpoint.fromChannel({
      type,
      accountId: "acct_feishu",
      chatId: "oc_chat",
      senderId: "ou_stale_endpoint_user",
    }),
    interaction: ChannelInteraction.forType(type),
  })
}

async function askAndDeliver(input: {
  adapter: Provider
  sessionID: string
  requesterId?: string
  messageId?: string
}) {
  const delivered = Promise.withResolvers<boolean>()
  const unsubscribe = Bus.subscribe(Question.Event.Asked, (event) => {
    if (event.properties.sessionID !== input.sessionID) return
    void QuestionCardRuntime.deliver({
      provider: input.adapter,
      accountId: "acct_feishu",
      chatId: "oc_chat",
      replyToMessageId: "om_topic",
      requesterId: input.requesterId ?? "ou_requester",
      sessionID: input.sessionID,
      request: event.properties,
    }).then(delivered.resolve, delivered.reject)
  })

  const answer = Question.ask({ sessionID: input.sessionID, questions })
  try {
    expect(await delivered.promise).toBe(true)
  } finally {
    unsubscribe()
  }
  const pending = await Question.list()
  expect(pending).toHaveLength(1)
  return { answer, requestId: pending[0].id }
}

function callback(requestId: string, overrides: Partial<QuestionCardCallback> = {}): QuestionCardCallback {
  return {
    eventId: "evt_001",
    requestId,
    messageId: "om_question_card",
    chatId: "oc_chat",
    requesterId: "ou_requester",
    formValues: [{ name: "question_0", selected: ["0"] }],
    ...overrides,
  }
}

describe("QuestionCardRuntime", () => {
  test("delivers Question.ask through the provider and resolves the original promise from opaque option indices", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createChannelSession()
        const sent: Array<Parameters<NonNullable<Provider["sendQuestionCard"]>>[0]> = []
        const adapter = provider("feishu", {
          onSendQuestionCard: async (input) => {
            sent.push(input)
            return { messageId: "om_question_card" }
          },
        })
        const pending = await askAndDeliver({ adapter, sessionID: session.id })

        expect(sent).toEqual([
          {
            accountId: "acct_feishu",
            chatId: "oc_chat",
            replyToMessageId: "om_topic",
            requestId: pending.requestId,
            questions,
          },
        ])
        expect(QuestionCardRuntime.hasRegistration(pending.requestId)).toBe(true)

        expect(
          await QuestionCardRuntime.acceptAction({
            channelType: "feishu",
            accountId: "acct_feishu",
            callback: callback(pending.requestId),
          }),
        ).toEqual({ status: "accepted" })
        expect(await pending.answer).toEqual([["Staging"]])
        expect(QuestionCardRuntime.hasRegistration(pending.requestId)).toBe(false)

        expect(
          await QuestionCardRuntime.acceptAction({
            channelType: "feishu",
            accountId: "acct_feishu",
            callback: callback(pending.requestId),
          }),
        ).toEqual({ status: "duplicate" })
        expect(
          await QuestionCardRuntime.acceptAction({
            channelType: "feishu",
            accountId: "acct_feishu",
            callback: callback(pending.requestId, { eventId: "evt_other" }),
          }),
        ).toEqual({ status: "expired" })
      },
    })
  })

  test("fails closed for mismatched ownership and invalid answers without settling the Question", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createChannelSession()
        const pending = await askAndDeliver({ adapter: provider("feishu"), sessionID: session.id })
        const valid = callback(pending.requestId)
        const invalidCases = [
          { accountId: "acct_other", callback: valid },
          { accountId: "acct_feishu", callback: { ...valid, chatId: "oc_other" } },
          { accountId: "acct_feishu", callback: { ...valid, requesterId: "ou_other" } },
          { accountId: "acct_feishu", callback: { ...valid, messageId: "om_other" } },
          {
            accountId: "acct_feishu",
            callback: { ...valid, formValues: [{ name: "question_0", selected: ["99"] }] },
          },
        ]

        for (const invalid of invalidCases) {
          expect(
            await QuestionCardRuntime.acceptAction({
              channelType: "feishu",
              accountId: invalid.accountId,
              callback: invalid.callback,
            }),
          ).toEqual({ status: "rejected" })
        }
        expect(await Question.list()).toHaveLength(1)

        await Question.reject(pending.requestId)
        await pending.answer.catch(() => undefined)
      },
    })
  })

  test("external reply cleanup expires the card while delivery failure rejects the pending Question", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createChannelSession()
        const pending = await askAndDeliver({ adapter: provider("feishu"), sessionID: session.id })
        const settled = Promise.withResolvers<void>()
        const unsubscribe = Bus.subscribe(Question.Event.Replied, (event) => {
          if (event.properties.requestID !== pending.requestId) return
          void QuestionCardRuntime.settle(event.properties.requestID).then(() => settled.resolve())
        })

        await Question.reply({ requestID: pending.requestId, answers: [["Production"]] })
        await settled.promise
        unsubscribe()
        expect(await pending.answer).toEqual([["Production"]])
        expect(
          await QuestionCardRuntime.acceptAction({
            channelType: "feishu",
            accountId: "acct_feishu",
            callback: callback(pending.requestId),
          }),
        ).toEqual({ status: "expired" })

        const failedSession = await createChannelSession()
        const delivered = Promise.withResolvers<boolean>()
        const unsubscribeFailed = Bus.subscribe(Question.Event.Asked, (event) => {
          if (event.properties.sessionID !== failedSession.id) return
          void QuestionCardRuntime.deliver({
            provider: provider("feishu", {
              onSendQuestionCard: async () => {
                throw new Error("Network failure sending question card")
              },
            }),
            accountId: "acct_feishu",
            chatId: "oc_chat",
            requesterId: "ou_requester",
            sessionID: failedSession.id,
            request: event.properties,
          }).then(delivered.resolve, delivered.reject)
        })
        const failedAnswer = Question.ask({ sessionID: failedSession.id, questions }).catch((error) => error)
        expect(await delivered.promise).toBe(false)
        unsubscribeFailed()
        expect(await failedAnswer).toBeInstanceOf(Question.RejectedError)
        expect(await Question.list()).toEqual([])
      },
    })
  })

  test("does not hold the request lock while provider delivery is in flight", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await createChannelSession()
        const sendStarted = Promise.withResolvers<void>()
        const sendResult = Promise.withResolvers<{ messageId: string }>()
        const answer = Question.ask({ sessionID: session.id, questions })
        const [request] = await Question.list()
        const delivery = QuestionCardRuntime.deliver({
          provider: provider("feishu", {
            onSendQuestionCard: async () => {
              sendStarted.resolve()
              return sendResult.promise
            },
          }),
          accountId: "acct_feishu",
          chatId: "oc_chat",
          requesterId: "ou_requester",
          sessionID: session.id,
          request,
        })

        await sendStarted.promise
        const settlement = QuestionCardRuntime.settle(request.id)
        const settledBeforeSend = await Promise.race([settlement.then(() => true), Bun.sleep(50).then(() => false)])
        sendResult.resolve({ messageId: "om_question_card" })
        const delivered = await delivery
        await settlement

        expect(settledBeforeSend).toBe(true)
        expect(delivered).toBe(false)
        expect(QuestionCardRuntime.hasRegistration(request.id)).toBe(false)
        await Question.reject(request.id)
        await answer.catch(() => undefined)
      },
    })
  })

  test("registrations are Scope-local and cannot be resolved from another project", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    const firstScope = await first.scope()
    const secondScope = await second.scope()
    let requestId = ""
    let answer: Promise<Question.Answer[]> | undefined

    await ScopeContext.provide({
      scope: firstScope,
      fn: async () => {
        const session = await createChannelSession()
        const pending = await askAndDeliver({ adapter: provider("feishu"), sessionID: session.id })
        requestId = pending.requestId
        answer = pending.answer
      },
    })

    await ScopeContext.provide({
      scope: secondScope,
      fn: async () => {
        expect(
          await QuestionCardRuntime.acceptAction({
            channelType: "feishu",
            accountId: "acct_feishu",
            callback: callback(requestId),
          }),
        ).toEqual({ status: "expired" })
      },
    })

    await ScopeContext.provide({
      scope: firstScope,
      fn: async () => {
        expect(
          await QuestionCardRuntime.acceptAction({
            channelType: "feishu",
            accountId: "acct_feishu",
            callback: callback(requestId),
          }),
        ).toEqual({ status: "accepted" })
      },
    })
    expect(await answer).toEqual([["Staging"]])
  })
})

describe("Channel interaction policy", () => {
  test("uses interactive Feishu sessions and keeps unsupported channels unattended", () => {
    expect(ChannelInteraction.forType("feishu")).toEqual({ mode: "interactive", source: "channel:feishu" })
    expect(ChannelInteraction.forType("slack")).toEqual({ mode: "unattended", source: "channel:slack" })
  })
})
