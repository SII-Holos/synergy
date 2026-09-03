import { beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { Channel } from "../../src/channel"
import type { OutboundPart, Provider } from "../../src/channel/types"
import { Identifier } from "../../src/id/id"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { ChannelPushTool } from "../../src/channel/tools/channel-push"
import { ToolRegistry } from "../../src/tool/registry"
import { SessionWorkflowService } from "../../src/session/workflow"
import type { Tool } from "../../src/tool/tool"
import { tmpdir } from "../fixture/fixture"

// Product domains register tools via the L4 manifest
import "../../src/product-registration"

const CHANNEL_TYPE = "test-channel-push"

type PushCall = { accountId: string; chatId: string; parts: OutboundPart[] }
type ReplyCall = {
  accountId: string
  messageId: string
  chatId?: string
  chatType?: "dm" | "group"
  parts: OutboundPart[]
  scopeKey?: string
}

function fakeProvider(): { calls: { push: PushCall[]; reply: ReplyCall[] }; provider: Provider } {
  const calls: { push: PushCall[]; reply: ReplyCall[] } = { push: [], reply: [] }
  const provider: Provider = {
    type: CHANNEL_TYPE,
    lifecycle: "self_connected",
    async connect() {},
    async pushMessage(input) {
      calls.push.push(input)
      return { messageId: "push_sent" }
    },
    async replyMessage(input) {
      calls.reply.push(input)
      return { messageId: "reply_sent" }
    },
  }
  return { calls, provider }
}

function ctx(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: Identifier.ascending("message"),
    callID: "call-channel-push-test",
    agent: "synergy-max",
    abort: AbortSignal.any([]),
    metadata: () => {},
    ask: async () => {},
  }
}

async function withScope<T>(fn: () => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true })
  const scope = (await Scope.fromDirectory(tmp.path)).scope
  return ScopeContext.provide({ scope, fn })
}

describe("channel_push tool", () => {
  const fake = fakeProvider()

  beforeEach(() => {
    fake.calls.push.length = 0
    fake.calls.reply.length = 0
  })

  beforeAll(() => {
    Channel.registerProvider(fake.provider)
  })

  test("registers in the tool registry", async () => {
    await withScope(async () => {
      expect(await ToolRegistry.find("channel_push")).toBeDefined()
    })
  })

  test("rejects sessions without a channel endpoint", async () => {
    await withScope(async () => {
      const plain = await Session.create({})
      const tool = await ChannelPushTool.init()
      await expect(tool.execute({ text: "hello" }, ctx(plain.id))).rejects.toThrow(
        "channel_push: session has no channel endpoint",
      )
    })
  })

  test("pushes to the endpoint chat with the endpoint account and chat IDs", async () => {
    await withScope(async () => {
      const session = await Session.create({
        endpoint: SessionEndpoint.fromChannel({
          type: CHANNEL_TYPE,
          accountId: "account-1",
          chatId: "chat-1",
          chatType: "group",
          scopeKey: "scope-1",
        }),
      })
      await SessionWorkflowService.enableBoss(session.id)
      const tool = await ChannelPushTool.init()
      const result = await tool.execute({ text: "hello" }, ctx(session.id))

      expect(fake.calls.push).toHaveLength(1)
      expect(fake.calls.push[0]).toEqual({
        accountId: "account-1",
        chatId: "chat-1",
        parts: [{ type: "text", text: "hello" }],
      })
      expect(fake.calls.reply).toHaveLength(0)
      expect(result.metadata).toMatchObject({ accountId: "account-1", chatId: "chat-1" })
      expect(result.output).toContain("chat-1")
    })
  })

  test("replies to a message when replyToMessageId is given", async () => {
    await withScope(async () => {
      const session = await Session.create({
        endpoint: SessionEndpoint.fromChannel({
          type: CHANNEL_TYPE,
          accountId: "account-1",
          chatId: "chat-1",
          chatType: "group",
          scopeKey: "scope-1",
        }),
      })
      await SessionWorkflowService.enableBoss(session.id)
      const tool = await ChannelPushTool.init()
      const result = await tool.execute({ text: "reply", replyToMessageId: "msg-9" }, ctx(session.id))

      expect(fake.calls.reply).toHaveLength(1)
      expect(fake.calls.reply[0]).toEqual({
        accountId: "account-1",
        messageId: "msg-9",
        chatId: "chat-1",
        chatType: "group",
        parts: [{ type: "text", text: "reply" }],
        scopeKey: "scope-1",
      })
      expect(fake.calls.push).toHaveLength(0)
      expect(result.metadata).toMatchObject({ replyToMessageId: "msg-9" })
    })
  })

  test("same-chat reply is exempt from the communication ask (R6 answer path)", async () => {
    await withScope(async () => {
      const session = await Session.create({
        endpoint: SessionEndpoint.fromChannel({
          type: CHANNEL_TYPE,
          accountId: "account-1",
          chatId: "chat-1",
          chatType: "group",
          scopeKey: "scope-1",
        }),
      })
      await SessionWorkflowService.enableBoss(session.id)
      const asks: string[] = []
      const tool = await ChannelPushTool.init()
      await tool.execute(
        { text: "好的", replyToMessageId: "msg-inbound" },
        {
          ...ctx(session.id),
          ask: async (input) => {
            asks.push(input.patterns.join(","))
          },
        },
      )

      expect(asks).toHaveLength(0)
      expect(fake.calls.reply).toHaveLength(1)
      expect(fake.calls.reply[0]).toMatchObject({ chatId: "chat-1", messageId: "msg-inbound" })
    })
  })

  test("cross-chat push still requires the communication ask (proactive outbound boundary)", async () => {
    await withScope(async () => {
      const session = await Session.create({
        endpoint: SessionEndpoint.fromChannel({
          type: CHANNEL_TYPE,
          accountId: "account-1",
          chatId: "chat-1",
          chatType: "group",
          scopeKey: "scope-1",
        }),
      })
      await SessionWorkflowService.enableBoss(session.id)
      const asks: string[] = []
      const tool = await ChannelPushTool.init()
      await tool.execute(
        { text: "主动汇报", chatId: "chat-other" },
        {
          ...ctx(session.id),
          ask: async (input) => {
            asks.push(input.patterns.join(","))
          },
        },
      )

      expect(asks).toEqual(["chat-other"])
      expect(fake.calls.push.at(-1)).toMatchObject({ chatId: "chat-other" })
    })
  })

  test("honors explicit accountId and chatId overrides", async () => {
    await withScope(async () => {
      const session = await Session.create({
        endpoint: SessionEndpoint.fromChannel({
          type: CHANNEL_TYPE,
          accountId: "account-1",
          chatId: "chat-1",
        }),
      })
      await SessionWorkflowService.enableBoss(session.id)
      const tool = await ChannelPushTool.init()
      const result = await tool.execute({ text: "hi", accountId: "account-2", chatId: "chat-2" }, ctx(session.id))

      expect(fake.calls.push.at(-1)).toEqual({
        accountId: "account-2",
        chatId: "chat-2",
        parts: [{ type: "text", text: "hi" }],
      })
      expect(result.metadata).toMatchObject({ accountId: "account-2", chatId: "chat-2" })
    })
  })

  test("rejects endpoints without a chatId when none is provided", async () => {
    await withScope(async () => {
      const session = await Session.create({
        endpoint: SessionEndpoint.fromChannel({
          type: CHANNEL_TYPE,
          accountId: "account-1",
          target: { kind: "chat", chatId: "chat-1" },
        }),
      })
      const tool = await ChannelPushTool.init()
      await expect(tool.execute({ text: "hello" }, ctx(session.id))).rejects.toThrow(
        "channel_push: session channel endpoint has no chatId",
      )
    })
  })

  test("rejects unknown channel providers", async () => {
    await withScope(async () => {
      const session = await Session.create({
        endpoint: SessionEndpoint.fromChannel({
          type: "no-such-provider",
          accountId: "account-1",
          chatId: "chat-1",
        }),
      })
      const tool = await ChannelPushTool.init()
      await expect(tool.execute({ text: "hello" }, ctx(session.id))).rejects.toThrow(
        'channel_push: no channel provider registered for "no-such-provider"',
      )
    })
  })

  test("uses conversation-scoped methods when the provider exposes them", async () => {
    const conversationCalls: { push: PushCall[]; reply: ReplyCall[] } = { push: [], reply: [] }
    Channel.registerProvider({
      type: "test-channel-push-conversation",
      lifecycle: "self_connected",
      conversation: {
        async pushMessage(input) {
          conversationCalls.push.push(input)
          return { messageId: "conversation_push_sent" }
        },
        async replyMessage(input) {
          conversationCalls.reply.push(input)
          return { messageId: "conversation_reply_sent" }
        },
      },
      async connect() {},
    } satisfies Provider)

    await withScope(async () => {
      const session = await Session.create({
        endpoint: SessionEndpoint.fromChannel({
          type: "test-channel-push-conversation",
          accountId: "account-1",
          chatId: "chat-1",
          chatType: "dm",
        }),
      })
      await SessionWorkflowService.enableBoss(session.id)
      const tool = await ChannelPushTool.init()
      await tool.execute({ text: "push" }, ctx(session.id))
      await tool.execute({ text: "reply", replyToMessageId: "msg-1" }, ctx(session.id))

      expect(conversationCalls.push).toHaveLength(1)
      expect(conversationCalls.push[0]).toMatchObject({ accountId: "account-1", chatId: "chat-1" })
      expect(conversationCalls.reply).toHaveLength(1)
      expect(conversationCalls.reply[0]).toMatchObject({ accountId: "account-1", messageId: "msg-1" })
    })
  })
})
