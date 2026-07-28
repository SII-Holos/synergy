import { expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Channel } from "../../src/channel"
import { ChannelOutbound } from "../../src/channel/outbound"
import type { Provider } from "../../src/channel/types"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

async function waitFor(check: () => boolean, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for channel delivery")
    await Bun.sleep(10)
  }
}

function provider(type: string, calls: { replies: string[]; pushes: string[] }): Provider {
  return {
    type,
    lifecycle: "self_connected",
    async connect() {},
    async replyMessage(input) {
      calls.replies.push(input.messageId)
      return { messageId: "reply_sent" }
    },
    async pushMessage(input) {
      calls.pushes.push(input.chatId)
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
}

async function completedAssistant(
  sessionID: string,
  text: string,
  finish = "stop",
  metadata: Record<string, unknown> = {
    channelPush: true,
    channelReply: true,
    channelReplyToMessageId: "msg_topic_root",
  },
) {
  const created = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    parentID: Identifier.ascending("message"),
    mode: "synergy",
    agent: "synergy",
    path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "test-model",
    providerID: "test-provider",
    time: { created: Date.now() },
    sessionID,
    metadata,
  } as MessageV2.Assistant)) as MessageV2.Assistant
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: created.id,
    sessionID,
    type: "text",
    text,
  })
  return (await Session.updateMessage({
    ...created,
    finish,
    time: { ...created.time, completed: Date.now() },
  })) as MessageV2.Assistant
}

test("replies async channel output to the persisted message anchor exactly once", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const type = `outbound-reply-${crypto.randomUUID()}`
      const calls = { replies: [] as string[], pushes: [] as string[] }
      Channel.registerProvider(provider(type, calls))
      const dispose = ChannelOutbound.init()
      try {
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({
            type,
            accountId: "acct_test",
            chatId: "chat_test",
          }),
        })

        const assistant = await completedAssistant(session.id, "Background work finished")
        await waitFor(() => calls.replies.length > 0)
        expect(calls.replies).toEqual(["msg_topic_root"])
        expect(calls.pushes).toEqual([])

        await Promise.all([
          Bus.publish(MessageV2.Event.Updated, { info: assistant }),
          Bus.publish(MessageV2.Event.Updated, { info: assistant }),
        ])
        await Bun.sleep(25)
        expect(calls.replies).toEqual(["msg_topic_root"])
      } finally {
        dispose()
      }
    },
  })
})

test("replies through providers that do not support proactive push", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const type = `outbound-reply-only-${crypto.randomUUID()}`
      const replies: string[] = []
      Channel.registerProvider({
        type,
        lifecycle: "self_connected",
        async connect() {},
        async replyMessage(input) {
          replies.push(input.messageId)
          return { messageId: "reply_sent" }
        },
      })
      const dispose = ChannelOutbound.init()
      try {
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({
            type,
            accountId: "acct_test",
            chatId: "chat_test",
          }),
        })

        await completedAssistant(session.id, "Background work finished")
        await waitFor(() => replies.length > 0)

        expect(replies).toEqual(["msg_topic_root"])
      } finally {
        dispose()
      }
    },
  })
})

test("preserves proactive channel push delivery without a reply intent", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const type = `outbound-push-${crypto.randomUUID()}`
      const calls = { replies: [] as string[], pushes: [] as string[] }
      Channel.registerProvider(provider(type, calls))
      const dispose = ChannelOutbound.init()
      try {
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({
            type,
            accountId: "acct_test",
            chatId: "chat_test",
          }),
        })

        await completedAssistant(session.id, "Proactive update", "stop", { channelPush: true })
        await waitFor(() => calls.pushes.length > 0)

        expect(calls.pushes).toEqual(["chat_test"])
        expect(calls.replies).toEqual([])
      } finally {
        dispose()
      }
    },
  })
})

test("does not downgrade async channel output to a chat push without a reply anchor", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const type = `outbound-no-anchor-${crypto.randomUUID()}`
      const calls = { replies: [] as string[], pushes: [] as string[] }
      Channel.registerProvider(provider(type, calls))
      const dispose = ChannelOutbound.init()
      try {
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({
            type,
            accountId: "acct_test",
            chatId: "chat_test",
          }),
        })

        await completedAssistant(session.id, "Background work finished", "stop", {
          channelPush: true,
          channelReply: true,
        })
        expect(calls.replies).toEqual([])
        await Bun.sleep(25)
        expect(calls.pushes).toEqual([])
      } finally {
        dispose()
      }
    },
  })
})

test("does not send non-terminal channel assistant steps", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const type = `outbound-tool-step-${crypto.randomUUID()}`
      const calls = { replies: [] as string[], pushes: [] as string[] }
      Channel.registerProvider(provider(type, calls))
      const dispose = ChannelOutbound.init()
      try {
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({
            type,
            accountId: "acct_test",
            chatId: "chat_test",
          }),
        })

        await completedAssistant(session.id, "Calling a tool", "tool-calls")
        expect(calls.replies).toEqual([])
        await Bun.sleep(25)
        expect(calls.pushes).toEqual([])
      } finally {
        dispose()
      }
    },
  })
})

test("uses the reply anchor carried by each assistant message", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const type = `outbound-message-anchor-${crypto.randomUUID()}`
      const calls = { replies: [] as string[], pushes: [] as string[] }
      Channel.registerProvider(provider(type, calls))
      const dispose = ChannelOutbound.init()
      try {
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({
            type,
            accountId: "acct_test",
            chatId: "chat_test",
          }),
        })

        await completedAssistant(session.id, "First background result", "stop", {
          channelPush: true,
          channelReply: true,
          channelReplyToMessageId: "msg_first_topic",
        })
        await waitFor(() => calls.replies.length === 1)

        await completedAssistant(session.id, "Second background result", "stop", {
          channelPush: true,
          channelReply: true,
          channelReplyToMessageId: "msg_second_topic",
        })
        await waitFor(() => calls.replies.length === 2)

        expect(calls.replies).toEqual(["msg_first_topic", "msg_second_topic"])
        expect(calls.pushes).toEqual([])
      } finally {
        dispose()
      }
    },
  })
})
