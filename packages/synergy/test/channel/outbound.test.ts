import { expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Channel } from "../../src/channel"
import { ChannelOutbound } from "../../src/channel/outbound"
import { replyChannelTaskAttachments } from "../../src/channel/outbound-parts"
import type { OutboundPart, Provider } from "../../src/channel/types"
import { Asset } from "../../src/asset/asset"
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

type ProviderCalls = {
  replies: string[]
  pushes: string[]
  replyParts?: OutboundPart[][]
  pushParts?: OutboundPart[][]
}

function provider(type: string, calls: ProviderCalls): Provider {
  return {
    type,
    async connect() {},
    async replyMessage(input) {
      calls.replies.push(input.messageId)
      calls.replyParts?.push(input.parts)
      return { messageId: "reply_sent" }
    },
    async pushMessage(input) {
      calls.pushes.push(input.chatId)
      calls.pushParts?.push(input.parts)
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
  rootID?: string,
  withText = true,
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
    ...(rootID ? { rootID } : {}),
  } as MessageV2.Assistant)) as MessageV2.Assistant
  if (withText) {
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: created.id,
      sessionID,
      type: "text",
      text,
    })
  }
  return (await Session.updateMessage({
    ...created,
    finish,
    time: { ...created.time, completed: Date.now() },
  })) as MessageV2.Assistant
}

async function completedToolAttachment(input: {
  sessionID: string
  rootID: string
  assetID: string
  mime: string
  filename: string
}) {
  const toolAssistant = await completedAssistant(input.sessionID, "", "tool-calls", {}, input.rootID, false)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: toolAssistant.id,
    sessionID: input.sessionID,
    type: "tool",
    callID: "call_generated_media",
    tool: "generate_meme",
    state: {
      status: "completed",
      input: {},
      output: "Generated media",
      title: "Generate media",
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
      attachments: [
        {
          id: Identifier.ascending("part"),
          messageID: toolAssistant.id,
          sessionID: input.sessionID,
          type: "attachment",
          mime: input.mime,
          filename: input.filename,
          url: `asset://${input.assetID}`,
          presentation: { renderer: "image" },
        },
      ],
    },
  })
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

test("delivers tool attachments from earlier assistant steps in the same channel task exactly once", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const type = `outbound-tool-attachment-${crypto.randomUUID()}`
      const calls: ProviderCalls = { replies: [], pushes: [], replyParts: [], pushParts: [] }
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
        const rootID = Identifier.ascending("message")
        const assetID = await Asset.write(
          Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"></svg>'),
          "image/svg+xml",
          "meme.svg",
        )
        await completedToolAttachment({
          sessionID: session.id,
          rootID,
          assetID,
          mime: "image/svg+xml",
          filename: "meme.svg",
        })

        const terminal = await completedAssistant(session.id, "Meme generated", "stop", undefined, rootID)
        await waitFor(() => (calls.replyParts?.length ?? 0) === 1)

        expect(calls.replyParts).toEqual([
          [
            { type: "text", text: "Meme generated" },
            {
              type: "file",
              path: Asset.resolvePath(assetID),
              filename: "meme.svg",
              contentType: "image/svg+xml",
            },
          ],
        ])

        await Promise.all([
          Bus.publish(MessageV2.Event.Updated, { info: terminal }),
          Bus.publish(MessageV2.Event.Updated, { info: terminal }),
        ])
        await Bun.sleep(25)
        expect(calls.replyParts).toHaveLength(1)
      } finally {
        dispose()
      }
    },
  })
})

test("replies with foreground task attachments as media-only parts on the original message", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const calls: ProviderCalls = { replies: [], pushes: [], replyParts: [], pushParts: [] }
      const session = await Session.create({
        endpoint: SessionEndpoint.fromChannel({
          type: `foreground-tool-attachment-${crypto.randomUUID()}`,
          accountId: "acct_test",
          chatId: "chat_test",
        }),
      })
      const rootID = Identifier.ascending("message")
      const assetID = await Asset.write(Buffer.from([137, 80, 78, 71]), "image/png", "preview.png")
      await completedToolAttachment({
        sessionID: session.id,
        rootID,
        assetID,
        mime: "image/png",
        filename: "preview.png",
      })
      const terminalInfo = await completedAssistant(session.id, "Preview generated", "stop", {}, rootID)
      const terminal = await MessageV2.get({ sessionID: session.id, messageID: terminalInfo.id })

      expect(
        await replyChannelTaskAttachments({
          provider: provider("foreground-test", calls),
          accountId: "acct_test",
          messageId: "msg_original_root",
          sessionID: session.id,
          terminal,
        }),
      ).toBe(true)
      expect(calls.replies).toEqual(["msg_original_root"])
      expect(calls.pushes).toEqual([])
      expect(calls.replyParts).toEqual([
        [
          {
            type: "image",
            path: Asset.resolvePath(assetID),
            filename: "preview.png",
            contentType: "image/png",
          },
        ],
      ])
    },
  })
})
