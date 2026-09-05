import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
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
import type { MessageV2 } from "../../src/session/message-v2"
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

function ctx(sessionID: string, messageID: string): Tool.Context {
  return {
    sessionID,
    messageID,
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

/**
 * Create a boss-role channel session plus a realistic inbound turn: a root
 * user message carrying the real channel chat metadata (the provisioned boss
 * endpoint stores a sentinel chatId, so the real chat always travels on the
 * inbound message) and a current assistant message the tool call runs under.
 */
async function createBossTurn(input: {
  endpointChatId?: string
  inboundChatId: string
  inboundChatType?: "dm" | "group"
  inboundReplyAnchor?: string
  accountId?: string
}) {
  const endpoint = SessionEndpoint.fromChannel({
    type: CHANNEL_TYPE,
    accountId: input.accountId ?? "account-1",
    chatId: input.endpointChatId ?? "boss",
    chatType: "group",
    scopeKey: "scope-1",
  })
  const session = await Session.create({ endpoint })
  await SessionWorkflowService.enableBoss(session.id)

  const rootID = Identifier.ascending("message")
  await Session.updateMessage({
    id: rootID,
    role: "user",
    sessionID: session.id,
    agent: "synergy",
    model: { providerID: "test-provider", modelID: "test-model" },
    isRoot: true,
    rootID,
    time: { created: Date.now() - 2 },
    metadata: {
      channelReply: true,
      channelReplyToMessageId: input.inboundReplyAnchor ?? "msg-inbound",
      channelRequesterId: "user-1",
      channelChatId: input.inboundChatId,
      channelChatName: "Some Chat",
      channelChatType: input.inboundChatType ?? "group",
      channelSenderId: "user-1",
      channelSenderName: "User",
    },
  } as MessageV2.User)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: rootID,
    sessionID: session.id,
    type: "text",
    text: "inbound request",
  })

  const assistantID = Identifier.ascending("message")
  await Session.updateMessage({
    id: assistantID,
    role: "assistant",
    sessionID: session.id,
    parentID: rootID,
    rootID,
    mode: "synergy",
    agent: "synergy",
    path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "test-model",
    providerID: "test-provider",
    time: { created: Date.now() - 1 },
  } as MessageV2.Assistant)

  return { session, rootID, assistantID }
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

  afterEach(() => {
    mock.restore()
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
      await expect(tool.execute({ text: "hello" }, ctx(plain.id, "msg_x"))).rejects.toThrow(
        "channel_push: session has no channel endpoint",
      )
    })
  })

  test("rejects non-boss sessions", async () => {
    await withScope(async () => {
      const session = await Session.create({
        endpoint: SessionEndpoint.fromChannel({
          type: CHANNEL_TYPE,
          accountId: "account-1",
          chatId: "chat-1",
        }),
      })
      const tool = await ChannelPushTool.init()
      await expect(tool.execute({ text: "hello" }, ctx(session.id, "msg_x"))).rejects.toThrow(
        "channel_push: only boss-role sessions may push to channels",
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
      await expect(tool.execute({ text: "hello" }, ctx(session.id, "msg_x"))).rejects.toThrow(
        'channel_push: no channel provider registered for "no-such-provider"',
      )
    })
  })

  test("anchored reply to the inbound chat is exempt from the communication ask and preserves the inbound chat type", async () => {
    await withScope(async () => {
      const { session, assistantID } = await createBossTurn({
        endpointChatId: "boss", // provisioned sentinel — never the real chat
        inboundChatId: "oc_real_chat",
        inboundChatType: "dm",
        inboundReplyAnchor: "om_inbound",
      })
      const asks: string[] = []
      const tool = await ChannelPushTool.init()
      const result = await tool.execute(
        { text: "好的", replyToMessageId: "om_inbound" },
        {
          ...ctx(session.id, assistantID),
          ask: async (input) => {
            asks.push(input.patterns.join(","))
          },
        },
      )

      expect(asks).toHaveLength(0)
      expect(fake.calls.reply).toHaveLength(1)
      // Targets the REAL inbound chat (not the sentinel endpoint chat) and
      // keeps the inbound dm chatType (not the aggregate group type).
      expect(fake.calls.reply[0]).toMatchObject({
        accountId: "account-1",
        chatId: "oc_real_chat",
        chatType: "dm",
        messageId: "om_inbound",
      })
      expect(result.metadata).toMatchObject({ chatId: "oc_real_chat", replyToMessageId: "om_inbound" })
    })
  })

  test("anchored reply defaults chatId to the inbound chat when omitted", async () => {
    await withScope(async () => {
      const { session, assistantID } = await createBossTurn({ inboundChatId: "oc_real_chat" })
      const tool = await ChannelPushTool.init()
      await tool.execute({ text: "好的", replyToMessageId: "om_inbound" }, ctx(session.id, assistantID))

      expect(fake.calls.reply).toHaveLength(1)
      expect(fake.calls.reply[0]).toMatchObject({ chatId: "oc_real_chat", chatType: "group" })
    })
  })

  test("cross-chat push still requires the communication ask (proactive outbound boundary)", async () => {
    await withScope(async () => {
      const { session, assistantID } = await createBossTurn({ inboundChatId: "oc_real_chat" })
      const asks: string[] = []
      const tool = await ChannelPushTool.init()
      await tool.execute(
        { text: "主动汇报", chatId: "chat-other" },
        {
          ...ctx(session.id, assistantID),
          ask: async (input) => {
            asks.push(input.patterns.join(","))
          },
        },
      )

      expect(asks).toEqual(["chat-other"])
      expect(fake.calls.push.at(-1)).toMatchObject({ chatId: "chat-other" })
    })
  })

  test("anchored reply as another account still requires the communication ask", async () => {
    await withScope(async () => {
      const { session, assistantID } = await createBossTurn({ inboundChatId: "oc_real_chat" })
      const asks: string[] = []
      const tool = await ChannelPushTool.init()
      await tool.execute(
        { text: "跨账号", accountId: "account-2", replyToMessageId: "om_inbound" },
        {
          ...ctx(session.id, assistantID),
          ask: async (input) => {
            asks.push(input.patterns.join(","))
          },
        },
      )

      expect(asks).toEqual(["oc_real_chat"])
      expect(fake.calls.reply.at(-1)).toMatchObject({ accountId: "account-2", messageId: "om_inbound" })
    })
  })

  test("unanchored push to the inbound chat is still a proactive push and asks", async () => {
    await withScope(async () => {
      const { session, assistantID } = await createBossTurn({ inboundChatId: "oc_real_chat" })
      const asks: string[] = []
      const tool = await ChannelPushTool.init()
      await tool.execute(
        { text: "新消息" },
        {
          ...ctx(session.id, assistantID),
          ask: async (input) => {
            asks.push(input.patterns.join(","))
          },
        },
      )

      expect(asks).toEqual(["oc_real_chat"])
      expect(fake.calls.push.at(-1)).toMatchObject({ chatId: "oc_real_chat" })
    })
  })

  test("push without any inbound context must name a chat explicitly", async () => {
    await withScope(async () => {
      // Boss session with no inbound turn at all (e.g. proactive agenda push).
      const session = await Session.create({
        endpoint: SessionEndpoint.fromChannel({
          type: CHANNEL_TYPE,
          accountId: "account-1",
          chatId: "boss",
          chatType: "group",
          scopeKey: "scope-1",
        }),
      })
      await SessionWorkflowService.enableBoss(session.id)
      const tool = await ChannelPushTool.init()
      await expect(tool.execute({ text: "hello" }, ctx(session.id, Identifier.ascending("message")))).rejects.toThrow(
        "channel_push: no target chat",
      )
    })
  })

  test("explicit chatId push without inbound context asks once and pushes", async () => {
    await withScope(async () => {
      const session = await Session.create({
        endpoint: SessionEndpoint.fromChannel({
          type: CHANNEL_TYPE,
          accountId: "account-1",
          chatId: "boss",
          chatType: "group",
          scopeKey: "scope-1",
        }),
      })
      await SessionWorkflowService.enableBoss(session.id)
      const asks: string[] = []
      const tool = await ChannelPushTool.init()
      await tool.execute(
        { text: "hello", chatId: "chat-target" },
        {
          ...ctx(session.id, Identifier.ascending("message")),
          ask: async (input) => {
            asks.push(input.patterns.join(","))
          },
        },
      )

      expect(asks).toEqual(["chat-target"])
      expect(fake.calls.push.at(-1)).toMatchObject({ chatId: "chat-target" })
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
      const endpoint = SessionEndpoint.fromChannel({
        type: "test-channel-push-conversation",
        accountId: "account-1",
        chatId: "boss",
        chatType: "group",
        scopeKey: "scope-1",
      })
      const session = await Session.create({ endpoint })
      await SessionWorkflowService.enableBoss(session.id)
      const rootID = Identifier.ascending("message")
      await Session.updateMessage({
        id: rootID,
        role: "user",
        sessionID: session.id,
        agent: "synergy",
        model: { providerID: "test-provider", modelID: "test-model" },
        isRoot: true,
        rootID,
        time: { created: Date.now() },
        metadata: {
          channelChatId: "chat-conv",
          channelChatType: "dm",
          channelReply: true,
          channelReplyToMessageId: "msg-conv",
        },
      } as MessageV2.User)
      const assistantID = Identifier.ascending("message")
      await Session.updateMessage({
        id: assistantID,
        role: "assistant",
        sessionID: session.id,
        parentID: rootID,
        rootID,
        mode: "synergy",
        agent: "synergy",
        path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "test-model",
        providerID: "test-provider",
        time: { created: Date.now() },
      } as MessageV2.Assistant)

      const tool = await ChannelPushTool.init()
      await tool.execute({ text: "push" }, ctx(session.id, assistantID))
      await tool.execute({ text: "reply", replyToMessageId: "msg-conv" }, ctx(session.id, assistantID))

      expect(conversationCalls.push).toHaveLength(1)
      expect(conversationCalls.push[0]).toMatchObject({ accountId: "account-1", chatId: "chat-conv" })
      expect(conversationCalls.reply).toHaveLength(1)
      expect(conversationCalls.reply[0]).toMatchObject({ accountId: "account-1", messageId: "msg-conv" })
    })
  })
})
