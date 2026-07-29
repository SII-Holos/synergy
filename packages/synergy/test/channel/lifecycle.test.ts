import { afterEach, describe, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import type { Config } from "../../src/config/config"
import { Config as ConfigRuntime } from "../../src/config/config"
import { Channel } from "../../src/channel"
import { ChannelHost } from "../../src/channel/host"
import type {
  Provider,
  QuestionCardCallback,
  QuestionCardActionResult,
  StreamingSession,
} from "../../src/channel/types"
import { QuestionCardRuntime } from "../../src/channel/question-card"
import { ChannelInteraction } from "../../src/channel/interaction"
import { Question } from "../../src/question"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { FeishuProvider } from "../../src/channel/provider/feishu"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

const originalConfigCurrent = ConfigRuntime.current

function streaming(): StreamingSession {
  return {
    async start() {},
    async update() {},
    async updateToolProgress() {},
    async close() {},
    isActive: () => false,
  }
}

function makeProvider(input: {
  type: string
  lifecycle: "self_connected" | "borrowed_transport"
  waitForTransport?: boolean
  onConnected?: (callbacks: { onDisconnect?: (reason?: string) => void; signal: AbortSignal }) => void
}) {
  let connectCount = 0
  let transportWaitCount = 0
  let callbacks: { onDisconnect?: (reason?: string) => void; signal: AbortSignal } | undefined
  const readyResolvers: Array<() => void> = []
  const value = {
    type: input.type,
    lifecycle: input.lifecycle,
    conversation: {
      async replyMessage() {
        return { messageId: "reply" }
      },
      async pushMessage() {
        return { messageId: "push" }
      },
      async addReaction() {},
      createStreamingSession: streaming,
    },
    async connect(connectInput: { onDisconnect?: (reason?: string) => void; signal: AbortSignal }) {
      connectCount += 1
      callbacks = connectInput
      input.onConnected?.(connectInput)
    },
  } as Provider & {
    waitForTransport?: (input: { accountId: string; signal: AbortSignal }) => Promise<void>
  }
  if (input.waitForTransport) {
    value.waitForTransport = ({ signal }) => {
      transportWaitCount += 1
      return new Promise<void>((resolve) => {
        if (signal.aborted) return resolve()
        const onAbort = () => resolve()
        signal.addEventListener("abort", onAbort, { once: true })
        readyResolvers.push(() => {
          signal.removeEventListener("abort", onAbort)
          resolve()
        })
      })
    }
  }
  return {
    value,
    connectCount: () => connectCount,
    transportWaitCount: () => transportWaitCount,
    readyTransport: () => readyResolvers.shift()?.(),
    disconnect: (reason = "test") => inHome(() => callbacks?.onDisconnect?.(reason)),
  }
}

function inHome<T>(fn: () => T | Promise<T>) {
  return ScopeContext.provide({ scope: Scope.home(), fn })
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const timeoutAt = Date.now() + 3_000
  while (!(await predicate()) && Date.now() < timeoutAt) await Bun.sleep(5)
  if (!(await predicate())) throw new Error("Timed out waiting for Channel lifecycle state")
}

async function configure(type: string, enabled: boolean) {
  ConfigRuntime.current = mock(async () => {
    return {
      channel: {
        [type]: {
          type,
          accounts: { account: { enabled } },
        },
      },
    } as unknown as Config.Info
  }) as typeof ConfigRuntime.current
  await inHome(async () => {
    await Channel.reload()
    await Channel.init()
  })
}

afterEach(async () => {
  ConfigRuntime.current = originalConfigCurrent
  await inHome(() => Channel.stopAll())
})

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

describe("Channel provider lifecycle capability", () => {
  test("keeps Feishu on the self-connected lifecycle", () => {
    expect(new FeishuProvider().lifecycle).toBe("self_connected")
  })

  test("self-connected providers retain the existing reconnect loop", async () => {
    const fake = makeProvider({ type: `self-${crypto.randomUUID()}`, lifecycle: "self_connected" })
    Channel.registerProvider(fake.value)
    await configure(fake.value.type, true)
    expect(fake.connectCount()).toBe(1)

    await fake.disconnect()
    await waitFor(() => fake.connectCount() === 2)
    expect(fake.connectCount()).toBe(2)

    await fake.disconnect()
    await waitFor(() => fake.connectCount() === 3)
    expect(fake.connectCount()).toBe(3)
  })

  test("borrowed_transport providers wait for transport and reconnect on disconnect", async () => {
    const fake = makeProvider({
      type: `borrowed-${crypto.randomUUID()}`,
      lifecycle: "borrowed_transport",
      waitForTransport: true,
    })
    Channel.registerProvider(fake.value)
    await configure(fake.value.type, true)
    expect(fake.transportWaitCount()).toBe(1)
    expect(fake.connectCount()).toBe(0)

    fake.readyTransport()
    await waitFor(() => fake.connectCount() === 1)
    expect(fake.connectCount()).toBe(1)

    await fake.disconnect()
    expect(fake.transportWaitCount()).toBe(2)
    fake.readyTransport()
    await waitFor(() => fake.connectCount() === 2)
    expect(fake.connectCount()).toBe(2)
  })

  test("disabled accounts are not connected", async () => {
    const fake = makeProvider({ type: `disabled-${crypto.randomUUID()}`, lifecycle: "self_connected" })
    Channel.registerProvider(fake.value)
    await configure(fake.value.type, false)

    expect(fake.connectCount()).toBe(0)
    expect(await inHome(() => Channel.status())).toMatchObject({
      [`${fake.value.type}:account`]: { status: "disabled" },
    })
  })
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

  const accountScope = await accountProject.scope()
  const configPath = path.join(accountProject.path, ".synergy", "synergy.d", "90-channels.jsonc")
  const config = await Bun.file(configPath).json()
  config.channel.feishu.accounts.scoped.projectDir = accountProject.path
  await Bun.write(configPath, JSON.stringify(config, null, 2))

  let onQuestionCardAction: ((callback: QuestionCardCallback) => Promise<QuestionCardActionResult>) | undefined

  const provider: Provider = {
    type: "feishu",
    lifecycle: "self_connected",
    async connect(input) {
      onQuestionCardAction = input.onQuestionCardAction
    },
    async sendQuestionCard() {
      return { messageId: "om_question_card" }
    },
  }
  Channel.registerProvider(provider)

  let requestId: string | undefined
  let answer: Promise<string[][]> | undefined
  try {
    await ScopeContext.provide({
      scope: accountScope,
      fn: async () => {
        await Channel.reload()
        await Channel.status()

        const endpoint = SessionEndpoint.fromChannel({
          type: "feishu",
          accountId: "scoped",
          chatId: "chat_test",
          createdAt: Date.now(),
        })
        const session = await Session.getOrCreateForEndpoint(endpoint, {
          scope: accountScope,
          interaction: ChannelInteraction.forType("feishu"),
        })

        answer = Question.ask({
          sessionID: session.id,
          questions: [
            {
              question: "Pick an environment",
              header: "Deploy target",
              options: [{ label: "Staging", description: "Deploy to staging" }],
            },
          ],
        })
        const pending = await Question.list()
        const request = pending.find((item) => item.sessionID === session.id)
        if (!request) throw new Error("Expected pending Question request")
        requestId = request.id
        expect(
          await QuestionCardRuntime.deliver({
            provider,
            accountId: "scoped",
            chatId: "oc_chat",
            requesterId: "ou_requester",
            sessionID: session.id,
            request,
          }),
        ).toBe(true)
      },
    })

    const accept = await waitForQuestionCardAction(() => onQuestionCardAction)
    expect(
      await accept({
        eventId: "evt_scoped",
        requestId: requestId!,
        messageId: "om_question_card",
        chatId: "oc_chat",
        requesterId: "ou_requester",
        formValues: [{ name: "question_0", selected: ["0"] }],
      }),
    ).toEqual({ status: "accepted" })

    expect(await answer!).toEqual([["Staging"]])
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

test("cleans inbound attachments when provider conversation capabilities are unavailable", async () => {
  await using tmp = await tmpdir({ git: true })
  const type = `missing-conversation-${crypto.randomUUID()}`
  let receive: ((message: ChannelHost.ConversationMessage) => Promise<void>) | undefined
  const provider: Provider = {
    type,
    lifecycle: "self_connected",
    async connect(input) {
      receive = input.host.conversations.receive
    },
  }
  Channel.registerProvider(provider)
  await configure(type, true)
  await waitFor(() => Boolean(receive))

  const attachmentPath = path.join(tmp.path, "inbound-attachment.txt")
  await fs.writeFile(attachmentPath, "temporary inbound attachment")
  await receive!({
    chatId: "chat_test",
    chatType: "dm",
    senderId: "sender_test",
    text: "hello",
    messageId: "message_test",
    timestamp: Date.now(),
    attachments: [
      {
        path: attachmentPath,
        filename: "inbound-attachment.txt",
        contentType: "text/plain",
      },
    ],
  })

  expect(
    await fs.stat(attachmentPath).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
})

test("cleans inbound attachments after a handled channel command", async () => {
  await using tmp = await tmpdir({ git: true })
  const type = `command-cleanup-${crypto.randomUUID()}`
  let receive: ((message: ChannelHost.ConversationMessage) => Promise<void>) | undefined
  const provider: Provider = {
    type,
    lifecycle: "self_connected",
    conversation: {
      async replyMessage() {
        return { messageId: "reply" }
      },
      async addReaction() {},
      createStreamingSession: streaming,
    },
    async connect(input) {
      receive = input.host.conversations.receive
    },
  }
  Channel.registerProvider(provider)
  await configure(type, true)
  await waitFor(() => Boolean(receive))

  const attachmentPath = path.join(tmp.path, "command-attachment.txt")
  await fs.writeFile(attachmentPath, "temporary command attachment")
  await receive!({
    chatId: "chat_test",
    chatType: "dm",
    senderId: "sender_test",
    text: "/help",
    messageId: "message_test",
    timestamp: Date.now(),
    attachments: [{ path: attachmentPath, filename: "command-attachment.txt", contentType: "text/plain" }],
  })

  expect(
    await fs.stat(attachmentPath).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
})

test("cleans inbound attachments when streaming session creation fails", async () => {
  await using tmp = await tmpdir({ git: true })
  const type = `streaming-cleanup-${crypto.randomUUID()}`
  let receive: ((message: ChannelHost.ConversationMessage) => Promise<void>) | undefined
  const provider: Provider = {
    type,
    lifecycle: "self_connected",
    conversation: {
      async replyMessage() {
        return { messageId: "reply" }
      },
      async addReaction() {},
      createStreamingSession() {
        throw new Error("streaming unavailable")
      },
    },
    async connect(input) {
      receive = input.host.conversations.receive
    },
  }
  Channel.registerProvider(provider)
  await configure(type, true)
  await waitFor(() => Boolean(receive))

  const attachmentPath = path.join(tmp.path, "streaming-attachment.txt")
  await fs.writeFile(attachmentPath, "temporary streaming attachment")
  await expect(
    receive!({
      chatId: "chat_test",
      chatType: "dm",
      senderId: "sender_test",
      text: "hello",
      messageId: "message_test",
      timestamp: Date.now(),
      attachments: [{ path: attachmentPath, filename: "streaming-attachment.txt", contentType: "text/plain" }],
    }),
  ).rejects.toThrow("streaming unavailable")

  expect(
    await fs.stat(attachmentPath).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
})
