import { describe, expect, test } from "bun:test"
import { Channel } from "../../src/channel"
import { ResponseCardRuntime } from "../../src/channel/response-card"
import type { Provider, ResponseCard } from "../../src/channel/types"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionInbox } from "../../src/session/inbox"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../fixture/fixture"

const card: ResponseCard = {
  title: "Deploy release",
  elements: [
    { type: "text", text: "Choose the deployment target." },
    { type: "button", id: "cancel", label: "Cancel", value: "cancel" },
    {
      type: "select",
      id: "environment",
      label: "Environment",
      options: [
        { label: "Staging", value: "staging" },
        { label: "Production", value: "production" },
      ],
    },
  ],
}

function provider(type: string, sent: Array<Record<string, unknown>>): Provider {
  return {
    type,
    async connect() {},
    async replyMessage() {
      return { messageId: "reply_sent" }
    },
    async pushMessage() {
      return { messageId: "push_sent" }
    },
    async sendResponseCard(input) {
      sent.push(input)
      return { messageId: "om_response_card" }
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

async function createTask(input: { sessionID: string; requesterId: string }) {
  const rootID = Identifier.ascending("message")
  await Session.updateMessage({
    id: rootID,
    sessionID: input.sessionID,
    role: "user",
    isRoot: true,
    rootID,
    agent: "synergy",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
    metadata: {
      channelPush: true,
      channelReply: true,
      channelReplyToMessageId: "om_topic",
      channelRequesterId: input.requesterId,
    },
  } as MessageV2.User)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: rootID,
    sessionID: input.sessionID,
    type: "text",
    text: "Offer deployment choices",
  })

  const toolMessageID = Identifier.ascending("message")
  await Session.updateMessage({
    id: toolMessageID,
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
    time: { created: Date.now(), completed: Date.now() },
    sessionID: input.sessionID,
    finish: "tool-calls",
  } as MessageV2.Assistant)
  const requestId = Identifier.ascending("part")
  await Session.updatePart({
    id: requestId,
    messageID: toolMessageID,
    sessionID: input.sessionID,
    type: "tool",
    callID: "call_response_card",
    tool: "response_card",
    state: {
      status: "completed",
      input: card,
      output: "Prepared response card",
      title: "Deploy release",
      metadata: { truncated: false, intent: { type: "response_card", card } },
      time: { start: Date.now(), end: Date.now() },
    },
  })

  const terminalID = Identifier.ascending("message")
  await Session.updateMessage({
    id: terminalID,
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
    time: { created: Date.now(), completed: Date.now() },
    sessionID: input.sessionID,
    finish: "stop",
  } as MessageV2.Assistant)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: terminalID,
    sessionID: input.sessionID,
    type: "text",
    text: "Choose an option below.",
  })

  return {
    rootID,
    requestId,
    terminal: await MessageV2.get({ sessionID: input.sessionID, messageID: terminalID }),
  }
}

describe("ResponseCardRuntime", () => {
  test("delivers and activates each task card once with the original requester binding", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const type = `response-card-${crypto.randomUUID()}`
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({
            type,
            accountId: "acct_test",
            chatId: "oc_chat",
            senderId: "ou_stale_endpoint_user",
          }),
        })
        const task = await createTask({ sessionID: session.id, requesterId: "ou_requester" })
        const sent: Array<Record<string, unknown>> = []
        const adapter = provider(type, sent)

        await Promise.all([
          ResponseCardRuntime.deliverTaskCards({
            provider: adapter,
            accountId: "acct_test",
            chatId: "oc_chat",
            replyToMessageId: "om_topic",
            sessionID: session.id,
            terminal: task.terminal,
          }),
          ResponseCardRuntime.deliverTaskCards({
            provider: adapter,
            accountId: "acct_test",
            chatId: "oc_chat",
            replyToMessageId: "om_topic",
            sessionID: session.id,
            terminal: task.terminal,
          }),
        ])

        expect(sent).toEqual([
          {
            accountId: "acct_test",
            chatId: "oc_chat",
            replyToMessageId: "om_topic",
            requestId: task.requestId,
            card,
          },
        ])
        expect(await Storage.read(StoragePath.channelResponseCard(type, "acct_test", task.requestId))).toMatchObject({
          version: 1,
          status: "active",
          requestId: task.requestId,
          channelType: type,
          accountId: "acct_test",
          chatId: "oc_chat",
          requesterId: "ou_requester",
          sessionID: session.id,
          messageId: "om_response_card",
          card,
        })
      },
    })
  })

  test("treats an unexpired pending registration as handled without risking a duplicate provider send", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const type = `response-card-pending-${crypto.randomUUID()}`
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({ type, accountId: "acct_test", chatId: "oc_chat" }),
        })
        const task = await createTask({ sessionID: session.id, requesterId: "ou_requester" })
        const now = Date.now()
        await Storage.write(StoragePath.channelResponseCard(type, "acct_test", task.requestId), {
          version: 1,
          status: "pending",
          requestId: task.requestId,
          channelType: type,
          accountId: "acct_test",
          chatId: "oc_chat",
          requesterId: "ou_requester",
          sessionID: session.id,
          replyToMessageId: "om_topic",
          card,
          createdAt: now,
          expiresAt: now + 60_000,
        })
        const sent: Array<Record<string, unknown>> = []

        expect(
          await ResponseCardRuntime.deliverTaskCards({
            provider: provider(type, sent),
            accountId: "acct_test",
            chatId: "oc_chat",
            replyToMessageId: "om_topic",
            sessionID: session.id,
            terminal: task.terminal,
          }),
        ).toBe(true)
        expect(sent).toEqual([])
        expect(await Storage.read(StoragePath.channelResponseCard(type, "acct_test", task.requestId))).toMatchObject({
          status: "pending",
          requestId: task.requestId,
        })
      },
    })
  })

  test("validates account, chat, requester, message, action, and expiry before durable task delivery", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const type = `response-card-callback-${crypto.randomUUID()}`
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({ type, accountId: "acct_test", chatId: "oc_chat" }),
        })
        const task = await createTask({ sessionID: session.id, requesterId: "ou_requester" })
        const sent: Array<Record<string, unknown>> = []
        const adapter = provider(type, sent)
        Channel.registerProvider(adapter)
        await ResponseCardRuntime.deliverTaskCards({
          provider: adapter,
          accountId: "acct_test",
          chatId: "oc_chat",
          replyToMessageId: "om_topic",
          sessionID: session.id,
          terminal: task.terminal,
        })

        const valid = {
          eventId: "a".repeat(64),
          requestId: task.requestId,
          messageId: "om_response_card",
          chatId: "oc_chat",
          requesterId: "ou_requester",
          action: { type: "select" as const, id: "response_card:environment", value: "production" },
        }
        const invalidCases = [
          { accountId: "acct_other", callback: valid },
          { accountId: "acct_test", callback: { ...valid, chatId: "oc_other" } },
          { accountId: "acct_test", callback: { ...valid, requesterId: "ou_other" } },
          { accountId: "acct_test", callback: { ...valid, messageId: "om_other" } },
          {
            accountId: "acct_test",
            callback: { ...valid, action: { type: "select" as const, id: "response_card:environment", value: "qa" } },
          },
        ]
        for (const invalid of invalidCases) {
          expect(await ResponseCardRuntime.acceptAction({ channelType: type, ...invalid })).toMatchObject({
            status: "rejected",
          })
        }
        expect(await SessionInbox.list(session.id)).toEqual([])

        await Storage.update<{
          expiresAt: number
        }>(StoragePath.channelResponseCard(type, "acct_test", task.requestId), (draft) => {
          draft.expiresAt = Date.now() - 1
        })
        expect(
          await ResponseCardRuntime.acceptAction({ channelType: type, accountId: "acct_test", callback: valid }),
        ).toEqual({ status: "expired" })
        expect(await SessionInbox.list(session.id)).toEqual([])
      },
    })
  })

  test("deduplicates a valid callback into one fresh Channel user task without executing the opaque value", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const type = `response-card-dedup-${crypto.randomUUID()}`
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({ type, accountId: "acct_test", chatId: "oc_chat" }),
        })
        const task = await createTask({ sessionID: session.id, requesterId: "ou_requester" })
        const adapter = provider(type, [])
        await ResponseCardRuntime.deliverTaskCards({
          provider: adapter,
          accountId: "acct_test",
          chatId: "oc_chat",
          replyToMessageId: "om_topic",
          sessionID: session.id,
          terminal: task.terminal,
        })
        const callback = {
          eventId: "b".repeat(64),
          requestId: task.requestId,
          messageId: "om_response_card",
          chatId: "oc_chat",
          requesterId: "ou_requester",
          action: {
            type: "button" as const,
            id: "response_card:cancel",
            value: "cancel",
          },
        }

        const [first, duplicate] = await Promise.all([
          ResponseCardRuntime.acceptAction({ channelType: type, accountId: "acct_test", callback }),
          ResponseCardRuntime.acceptAction({ channelType: type, accountId: "acct_test", callback }),
        ])
        expect([first.status, duplicate.status].sort()).toEqual(["accepted", "duplicate"])

        const items = await SessionInbox.list(session.id)
        expect(items).toHaveLength(1)
        expect(items[0]).toMatchObject({
          mode: "task",
          deliveryKey: `response-card:${type}:acct_test:${callback.eventId}`,
          message: {
            role: "user",
            parts: [{ type: "text", text: 'Selected "Cancel" on "Deploy release".' }],
            origin: { type: "channel" },
            metadata: {
              channelPush: true,
              channelReply: true,
              channelReplyToMessageId: "om_response_card",
              channelRequesterId: "ou_requester",
              responseCardAction: callback,
            },
          },
        })
        expect(JSON.stringify(items[0].message?.parts)).not.toContain("bash")
      },
    })
  })

  test("provider send failure preserves pending registration and blocks retry", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const type = `response-card-fail-${crypto.randomUUID()}`
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({
            type,
            accountId: "acct_test",
            chatId: "oc_chat",
            senderId: "ou_requester",
          }),
        })
        const task = await createTask({ sessionID: session.id, requesterId: "ou_requester" })

        const firstCalls: Array<Record<string, unknown>> = []
        const failingProvider: Provider = {
          ...provider(type, firstCalls),
          async sendResponseCard(recv) {
            firstCalls.push(recv)
            throw new Error("Network failure")
          },
        }

        await expect(
          ResponseCardRuntime.deliverTaskCards({
            provider: failingProvider,
            accountId: "acct_test",
            chatId: "oc_chat",
            replyToMessageId: "om_topic",
            sessionID: session.id,
            terminal: task.terminal,
          }),
        ).rejects.toThrow("Network failure")

        const saved = await Storage.read(StoragePath.channelResponseCard(type, "acct_test", task.requestId))
        expect(saved).toMatchObject({
          status: "pending",
          requestId: task.requestId,
        })

        const secondCalls: Array<Record<string, unknown>> = []
        const secondResult = await ResponseCardRuntime.deliverTaskCards({
          provider: provider(type, secondCalls),
          accountId: "acct_test",
          chatId: "oc_chat",
          replyToMessageId: "om_topic",
          sessionID: session.id,
          terminal: task.terminal,
        })
        expect(secondResult).toBe(true)
        expect(secondCalls).toEqual([])
      },
    })
  })

  test("pruneExpired removes expired response-card registrations globally while preserving unexpired ones", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const type = `response-card-prune-${crypto.randomUUID()}`
        const now = Date.now()

        const expiredA = {
          version: 1 as const,
          status: "pending" as const,
          requestId: "req_a",
          channelType: type,
          accountId: "acct_a",
          chatId: "oc_a",
          requesterId: "ou_a",
          sessionID: "ses_a",
          replyToMessageId: "om_a",
          card: { title: "Expired A", elements: [{ type: "text" as const, text: "gone" }] },
          createdAt: now - 100_000,
          expiresAt: now - 1_000,
        }
        const unexpired = {
          version: 1 as const,
          status: "active" as const,
          requestId: "req_b",
          channelType: type,
          accountId: "acct_b",
          chatId: "oc_b",
          requesterId: "ou_b",
          sessionID: "ses_b",
          replyToMessageId: "om_b",
          messageId: "msg_b",
          card: { title: "Unexpired B", elements: [{ type: "text" as const, text: "keep" }] },
          createdAt: now - 10_000,
          expiresAt: now + 60_000,
        }
        const expiredC = {
          version: 1 as const,
          status: "pending" as const,
          requestId: "req_c",
          channelType: type,
          accountId: "acct_c",
          chatId: "oc_c",
          requesterId: "ou_c",
          sessionID: "ses_c",
          replyToMessageId: "om_c",
          card: { title: "Expired C", elements: [{ type: "text" as const, text: "gone too" }] },
          createdAt: now - 200_000,
          expiresAt: now - 5_000,
        }

        await Storage.write(StoragePath.channelResponseCard(type, "acct_a", "req_a"), expiredA)
        await Storage.write(StoragePath.channelResponseCard(type, "acct_b", "req_b"), unexpired)
        await Storage.write(StoragePath.channelResponseCard(type, "acct_c", "req_c"), expiredC)

        await ResponseCardRuntime.pruneExpired()

        await expect(Storage.read(StoragePath.channelResponseCard(type, "acct_a", "req_a"))).rejects.toThrow()
        await expect(Storage.read(StoragePath.channelResponseCard(type, "acct_c", "req_c"))).rejects.toThrow()

        const saved = await Storage.read(StoragePath.channelResponseCard(type, "acct_b", "req_b"))
        expect(saved).toMatchObject({
          requestId: "req_b",
          status: "active",
        })
      },
    })
  })

  test("pruneExpired removes malformed registration records", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const type = `response-card-malformed-${crypto.randomUUID()}`
        const key = StoragePath.channelResponseCard(type, "acct_a", "req_a")
        await Storage.write(key, { not: "a valid registration" })

        await ResponseCardRuntime.pruneExpired()

        await expect(Storage.read(key)).rejects.toThrow()
      },
    })
  })
})
