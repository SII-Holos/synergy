import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Channel } from "../../src/channel"
import { QuestionCardBridge } from "../../src/channel/question-card-bridge"
import type { Provider } from "../../src/channel/types"
import { Question } from "../../src/question"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { MessageV2 } from "../../src/session/message-v2"
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

test("delivers continuation questions from durable channel root metadata after the inbound handler is gone", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const type = `question-bridge-${crypto.randomUUID()}`
      const sent = Promise.withResolvers<Parameters<NonNullable<Provider["sendQuestionCard"]>>[0]>()
      const provider: Provider = {
        type,
        async connect() {},
        async replyMessage() {
          return { messageId: "reply_sent" }
        },
        async pushMessage() {
          return { messageId: "push_sent" }
        },
        async sendQuestionCard(input) {
          sent.resolve(input)
          return { messageId: "om_question_card" }
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
      Channel.registerProvider(provider)
      const dispose = QuestionCardBridge.init()
      const session = await Session.create({
        endpoint: SessionEndpoint.fromChannel({
          type,
          accountId: "acct_test",
          chatId: "oc_chat",
          senderId: "ou_stale_endpoint_user",
        }),
      })
      const rootID = Identifier.ascending("message")
      await Session.updateMessage({
        id: rootID,
        sessionID: session.id,
        role: "user",
        isRoot: true,
        rootID,
        agent: "synergy",
        model: { providerID: "test-provider", modelID: "test-model" },
        time: { created: Date.now() },
        metadata: {
          channelReplyToMessageId: "om_original_topic",
          channelRequesterId: "ou_original_requester",
        },
      } as MessageV2.User)
      const assistantID = Identifier.ascending("message")
      await Session.updateMessage({
        id: assistantID,
        parentID: rootID,
        rootID,
        role: "assistant",
        mode: "synergy",
        agent: "synergy",
        path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "test-model",
        providerID: "test-provider",
        time: { created: Date.now() },
        sessionID: session.id,
      } as MessageV2.Assistant)

      const answer = Question.ask({
        sessionID: session.id,
        questions,
        tool: { messageID: assistantID, callID: "call_question" },
      })
      const delivery = await sent.promise
      expect(delivery).toEqual({
        accountId: "acct_test",
        chatId: "oc_chat",
        replyToMessageId: "om_original_topic",
        requestId: expect.any(String),
        questions,
      })

      await Question.reject(delivery.requestId)
      await expect(answer).rejects.toBeInstanceOf(Question.RejectedError)
      dispose()
    },
  })
})
