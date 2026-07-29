import { expect, mock, test } from "bun:test"
import path from "path"
import { Channel } from "../../src/channel"
import { FeishuProvider } from "../../src/channel/provider/feishu"
import type { MessageHandler, Provider, QuestionCardCallback, QuestionCardActionResult } from "../../src/channel/types"
import { QuestionCardRuntime } from "../../src/channel/question-card"
import { ChannelInteraction } from "../../src/channel/interaction"
import { Question } from "../../src/question"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionInvoke } from "../../src/session/invoke"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

async function waitForHandler(read: () => MessageHandler | undefined): Promise<MessageHandler> {
  const deadline = Date.now() + 1_000
  while (!read()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Channel provider connection")
    await Bun.sleep(10)
  }
  return read()!
}
async function waitForQuestionCardAction(
  read: () => ((callback: QuestionCardCallback) => Promise<QuestionCardActionResult>) | undefined,
): Promise<(callback: QuestionCardCallback) => Promise<QuestionCardActionResult>> {
  const deadline = Date.now() + 1_000
  while (!read()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Question Card callback")
    await Bun.sleep(10)
  }
  return read()!
}

test("cleans inbound attachments and falls back when streaming startup fails", async () => {
  await using tmp = await tmpdir({
    git: true,
    config: {
      channel: {
        feishu: {
          type: "feishu",
          accounts: {
            cleanup: {
              enabled: true,
              appId: "app",
              appSecret: "secret",
              allowDM: true,
              allowGroup: true,
              requireMention: false,
              projectDir: "placeholder",
              streaming: true,
              streamingThrottleMs: 100,
              groupSessionScope: "group",
              inboundDebounceMs: 0,
              resolveSenderNames: false,
              replyInThread: false,
            },
          },
          streaming: true,
        },
      },
    },
  })

  const configPath = path.join(tmp.path, ".synergy", "synergy.d", "90-channels.jsonc")
  const config = await Bun.file(configPath).json()
  config.channel.feishu.accounts.cleanup.projectDir = tmp.path
  await Bun.write(configPath, JSON.stringify(config, null, 2))

  let onMessage: MessageHandler | undefined
  let failStreamingStart = false
  const replies: Array<{ messageId: string; text?: string }> = []
  const provider: Provider = {
    type: "feishu",
    async connect(input) {
      onMessage = input.onMessage
    },
    async replyMessage(input) {
      replies.push({
        messageId: input.messageId,
        text: input.parts.find((part) => part.type === "text")?.text,
      })
      return { messageId: "reply_sent" }
    },
    async pushMessage() {
      return { messageId: "push_sent" }
    },
    async addReaction() {},
    createStreamingSession() {
      return {
        async start() {
          if (failStreamingStart) throw new Error("streaming start failed")
        },
        async update() {},
        async updateToolProgress() {},
        async close() {},
        isActive: () => false,
      }
    },
  }

  Channel.registerProvider(provider)
  const scope = await tmp.scope()
  try {
    await ScopeContext.provide({
      scope,
      fn: async () => {
        try {
          await Channel.reload()
          await Channel.status()
          const handleMessage = await waitForHandler(() => onMessage)

          const commandAttachment = path.join(tmp.path, "command-attachment.txt")
          await Bun.write(commandAttachment, "command")
          await handleMessage({
            channelType: "feishu",
            accountId: "cleanup",
            chatId: "chat_test",
            chatType: "dm",
            senderId: "user_test",
            text: "/help",
            messageId: "msg_command",
            timestamp: Date.now(),
            attachments: [{ path: commandAttachment, contentType: "text/plain" }],
          })
          expect(replies).toEqual([{ messageId: "msg_command", text: expect.any(String) }])
          expect(await Bun.file(commandAttachment).exists()).toBe(false)

          failStreamingStart = true
          const originalInvoke = SessionInvoke.invoke
          ;(SessionInvoke.invoke as unknown) = mock(async (input: Parameters<typeof SessionInvoke.invoke>[0]) => {
            const rootID = `root_${crypto.randomUUID()}`
            const assistantID = `assistant_${crypto.randomUUID()}`
            return {
              info: {
                id: assistantID,
                sessionID: input.sessionID,
                role: "assistant",
                parentID: rootID,
                rootID,
                time: { created: Date.now(), completed: Date.now() },
                finish: "stop",
              },
              parts: [{ type: "text", text: "durable final answer" }],
            }
          })
          const startupAttachment = path.join(tmp.path, "startup-attachment.txt")
          await Bun.write(startupAttachment, "startup")
          try {
            await handleMessage({
              channelType: "feishu",
              accountId: "cleanup",
              chatId: "chat_test",
              chatType: "dm",
              senderId: "user_test",
              text: "Analyze this file",
              messageId: "msg_startup",
              timestamp: Date.now(),
              attachments: [{ path: startupAttachment, contentType: "text/plain" }],
            })
          } finally {
            ;(SessionInvoke.invoke as unknown) = originalInvoke
          }
          expect(replies.at(-1)).toEqual({ messageId: "msg_startup", text: "durable final answer" })
          expect(await Bun.file(startupAttachment).exists()).toBe(false)
        } finally {
          await Channel.stopAll()
        }
      },
    })
  } finally {
    Channel.registerProvider(new FeishuProvider())
  }
})

test("waits for provider drain before stopping a channel account", async () => {
  await using tmp = await tmpdir({
    git: true,
    config: {
      channel: {
        feishu: {
          type: "feishu",
          accounts: {
            drain: {
              enabled: true,
              appId: "app",
              appSecret: "secret",
              allowDM: true,
              allowGroup: true,
              requireMention: false,
              projectDir: "placeholder",
              streaming: true,
              streamingThrottleMs: 100,
              groupSessionScope: "group",
              inboundDebounceMs: 0,
              resolveSenderNames: false,
              replyInThread: false,
            },
          },
          streaming: true,
        },
      },
    },
  })
  const configPath = path.join(tmp.path, ".synergy", "synergy.d", "90-channels.jsonc")
  const config = await Bun.file(configPath).json()
  config.channel.feishu.accounts.drain.projectDir = tmp.path
  await Bun.write(configPath, JSON.stringify(config, null, 2))

  const drain = Promise.withResolvers<void>()
  let disconnected = false
  const provider: Provider = {
    type: "feishu",
    async connect() {},
    async disconnect() {
      await drain.promise
      disconnected = true
    },
    async replyMessage() {
      return { messageId: "reply_sent" }
    },
    async pushMessage() {
      return { messageId: "push_sent" }
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
  try {
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Channel.reload()
        await Channel.status()
        let stopped = false
        const stop = Channel.stopAll().then(() => {
          stopped = true
        })
        await Bun.sleep(10)
        expect(stopped).toBe(false)
        drain.resolve()
        await stop
        expect(disconnected).toBe(true)
      },
    })
  } finally {
    drain.resolve()
    Channel.registerProvider(new FeishuProvider())
  }
})

test("routes question card callbacks into the account project Scope", async () => {
  await using accountProject = await tmpdir({
    git: true,
    config: {
      channel: {
        feishu: {
          type: "feishu",
          accounts: {
            scoped: {
              enabled: true,
              appId: "app",
              appSecret: "secret",
              allowDM: true,
              allowGroup: true,
              requireMention: false,
              projectDir: "placeholder",
              streaming: true,
              streamingThrottleMs: 100,
              groupSessionScope: "group",
              inboundDebounceMs: 0,
              resolveSenderNames: false,
              replyInThread: false,
            },
          },
          streaming: true,
        },
      },
    },
  })
  await using callbackProject = await tmpdir({ git: true })

  const configPath = path.join(accountProject.path, ".synergy", "synergy.d", "90-channels.jsonc")
  const config = await Bun.file(configPath).json()
  config.channel.feishu.accounts.scoped.projectDir = accountProject.path
  await Bun.write(configPath, JSON.stringify(config, null, 2))

  let onQuestionCardAction: ((callback: QuestionCardCallback) => Promise<QuestionCardActionResult>) | undefined
  const provider: Provider = {
    type: "feishu",
    async connect(input) {
      onQuestionCardAction = input.onQuestionCardAction
    },
    async replyMessage() {
      return { messageId: "reply_sent" }
    },
    async pushMessage() {
      return { messageId: "push_sent" }
    },
    async sendQuestionCard() {
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
  const accountScope = await accountProject.scope()
  const callbackScope = await callbackProject.scope()
  let answer: Promise<Question.Answer[]> | undefined
  let requestId = ""

  try {
    await ScopeContext.provide({
      scope: accountScope,
      fn: async () => {
        await Channel.reload()
        await Channel.status()
        await waitForQuestionCardAction(() => onQuestionCardAction)

        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({
            type: "feishu",
            accountId: "scoped",
            chatId: "oc_chat",
            senderId: "ou_requester",
          }),
          interaction: ChannelInteraction.forType("feishu"),
        })
        answer = Question.ask({
          sessionID: session.id,
          questions: [
            {
              question: "Which environment?",
              header: "Env",
              options: [
                { label: "Staging", description: "Staging server" },
                { label: "Production", description: "Production server" },
              ],
            },
          ],
        })
        const pending = await Question.list()
        requestId = pending[0].id
        expect(
          await QuestionCardRuntime.deliver({
            provider,
            accountId: "scoped",
            chatId: "oc_chat",
            requesterId: "ou_requester",
            sessionID: session.id,
            request: pending[0],
          }),
        ).toBe(true)
      },
    })

    await ScopeContext.provide({
      scope: callbackScope,
      fn: async () => {
        const accept = await waitForQuestionCardAction(() => onQuestionCardAction)
        expect(
          await accept({
            eventId: "evt_scoped",
            requestId,
            messageId: "om_question_card",
            chatId: "oc_chat",
            requesterId: "ou_requester",
            formValues: [{ name: "question_0", selected: ["0"] }],
          }),
        ).toEqual({ status: "accepted" })
      },
    })

    expect(await answer).toEqual([["Staging"]])
  } finally {
    await ScopeContext.provide({
      scope: accountScope,
      fn: async () => {
        await Channel.stopAll()
        if (requestId) await QuestionCardRuntime.settle(requestId)
      },
    })
    Channel.registerProvider(new FeishuProvider())
  }
})
