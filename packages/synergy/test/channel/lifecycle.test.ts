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
import { ClarusProvider } from "../../src/channel/provider/clarus"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"
import { FakeNativeTunnelPort } from "./clarus-fixture"

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
  failConnectAttempts?: number
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
      if (connectCount <= (input.failConnectAttempts ?? 0)) throw new Error("provider initialization failed")
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

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const timeoutAt = Date.now() + timeoutMs
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
    await waitFor(() => fake.transportWaitCount() === 2)
    fake.readyTransport()
    await waitFor(() => fake.connectCount() === 2)
    expect(fake.connectCount()).toBe(2)
  })

  test("borrowed_transport providers retry initialization after the next readiness cycle", async () => {
    const fake = makeProvider({
      type: `borrowed-init-${crypto.randomUUID()}`,
      lifecycle: "borrowed_transport",
      waitForTransport: true,
      failConnectAttempts: 1,
    })
    Channel.registerProvider(fake.value)
    await configure(fake.value.type, true)

    await waitFor(() => fake.transportWaitCount() === 1)
    fake.readyTransport()
    await waitFor(() => fake.connectCount() === 1)
    expect(await inHome(() => Channel.status())).toMatchObject({
      [`${fake.value.type}:account`]: { status: "connecting" },
    })

    await waitFor(() => fake.transportWaitCount() === 2, 5_000)
    expect(fake.connectCount()).toBe(1)
    fake.readyTransport()
    await waitFor(() => fake.connectCount() === 2)
    expect(await inHome(() => Channel.status())).toMatchObject({
      [`${fake.value.type}:account`]: { status: "connected" },
    })
  })

  test("stopping a borrowed_transport provider during retry backoff marks it disconnected", async () => {
    const fake = makeProvider({
      type: `borrowed-stop-${crypto.randomUUID()}`,
      lifecycle: "borrowed_transport",
      waitForTransport: true,
      failConnectAttempts: 1,
    })
    Channel.registerProvider(fake.value)
    await configure(fake.value.type, true)

    fake.readyTransport()
    await waitFor(() => fake.connectCount() === 1)
    await Bun.sleep(10)
    await inHome(() => Channel.disconnect(fake.value.type, "account"))

    expect(await inHome(() => Channel.status())).toMatchObject({
      [`${fake.value.type}:account`]: { status: "disconnected" },
    })
  })

  test("stopping all channels during borrowed_transport retry backoff marks it disconnected", async () => {
    const fake = makeProvider({
      type: `borrowed-stop-all-${crypto.randomUUID()}`,
      lifecycle: "borrowed_transport",
      waitForTransport: true,
      failConnectAttempts: 1,
    })
    Channel.registerProvider(fake.value)
    await configure(fake.value.type, true)

    fake.readyTransport()
    await waitFor(() => fake.connectCount() === 1)
    await Bun.sleep(10)
    await inHome(() => Channel.disconnectAll())

    expect(await inHome(() => Channel.status())).toMatchObject({
      [`${fake.value.type}:account`]: { status: "disconnected" },
    })
  })

  test("borrowed_transport providers recover when transport disconnects during initial connect", async () => {
    const type = `borrowed-initial-sync-${crypto.randomUUID()}`
    let transportWaitCount = 0
    let connectCount = 0
    const readyResolvers: Array<() => void> = []
    const connectAttempts: Array<{
      disconnect: (reason?: string) => void
      reject: (error: Error) => void
    }> = []
    const provider: Provider & {
      waitForTransport(input: { accountId: string; signal: AbortSignal }): Promise<void>
    } = {
      type,
      lifecycle: "borrowed_transport",
      waitForTransport({ signal }) {
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
      },
      connect(input) {
        connectCount += 1
        return new Promise<void>((_resolve, reject) => {
          connectAttempts.push({
            disconnect: (reason) => input.onDisconnect?.(reason),
            reject,
          })
        })
      },
    }
    Channel.registerProvider(provider)
    await configure(type, true)

    readyResolvers.shift()?.()
    await waitFor(() => connectCount === 1)
    connectAttempts[0]?.disconnect("transport replaced during initial sync")

    await waitFor(() => transportWaitCount === 2)
    expect(await inHome(() => Channel.status())).toMatchObject({
      [`${type}:account`]: { status: "waiting_for_transport" },
    })

    readyResolvers.shift()?.()
    await waitFor(() => connectCount === 2)
    connectAttempts[0]?.reject(new Error("stale initial sync failed"))
    await Bun.sleep(10)
    expect(await inHome(() => Channel.status())).toMatchObject({
      [`${type}:account`]: { status: "connecting" },
    })
  })

  test("real ClarusProvider reconnects after transport replacement during initial subscription", async () => {
    const originalFetch = globalThis.fetch
    const fake = new FakeNativeTunnelPort()
    fake.setAgentID("account")
    let transportStatus: "connected" | "disconnected" = "connected"
    let generation = 1
    const provider = new ClarusProvider({
      auth: {
        getStoredCredential: async () => ({
          agentId: "account",
          agentSecret: "secret",
          maskedSecret: "test-secret",
        }),
        getCredentialOrThrow: async () => ({
          agentId: "account",
          agentSecret: "secret",
          maskedSecret: "test-secret",
        }),
      },
      runtime: {
        status: async () => ({ status: transportStatus }),
        getNativeIdentity: async () => ({
          agentID: "account",
          sessionID: `session-${generation}`,
          generation,
          epoch: generation,
        }),
        getNativeTunnel: async () => fake,
      },
    })
    Channel.registerProvider(provider)
    ConfigRuntime.current = mock(async () => ({
      channel: {
        clarus: {
          type: "clarus",
          accounts: { account: { enabled: true, apiUrl: "https://clarus-api.test" } },
        },
      },
    })) as typeof ConfigRuntime.current
    globalThis.fetch = Object.assign(
      mock(async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input)
        const status = new URL(request.url).searchParams.get("status")
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: status === "active" ? [{ project_id: "project-a", title: "Project A", status: "active" }] : [],
              next_cursor: null,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      }),
      { preconnect: originalFetch.preconnect },
    )

    try {
      await inHome(async () => {
        await Channel.reload()
        await Channel.init()
      })
      await waitFor(() => fake.pending.size === 1)

      transportStatus = "disconnected"
      await inHome(() =>
        fake.emitConnection({
          type: "disconnected",
          agentID: "account",
          sessionID: "session-1",
          generation: 1,
          epoch: 1,
          reason: "transport replaced during initial subscription",
        }),
      )
      await waitFor(
        async () => (await inHome(() => Channel.status()))["clarus:account"]?.status === "waiting_for_transport",
      )

      generation = 2
      fake.setGeneration(2)
      fake.setEpoch(2)
      transportStatus = "connected"
      await inHome(() =>
        fake.emitConnection({
          type: "connected",
          agentID: "account",
          sessionID: "session-2",
          generation: 2,
          epoch: 2,
        }),
      )
      await waitFor(() => fake.pending.size === 2)
      await inHome(() => {
        for (const requestID of [...fake.pending.keys()]) {
          fake.fulfill(requestID, {
            type: "clarus.project.subscribed",
            requestID,
            payload: { project_id: "project-a", subscribed: true },
          })
        }
      })

      await waitFor(async () => (await inHome(() => Channel.status()))["clarus:account"]?.status === "connected")
    } finally {
      globalThis.fetch = originalFetch
    }
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
    lifecycle: "self_connected",
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
