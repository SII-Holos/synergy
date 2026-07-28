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
})
