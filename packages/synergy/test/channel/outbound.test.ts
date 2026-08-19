import { expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Channel } from "../../src/channel"
import { ChannelOutbound } from "../../src/channel/outbound"
import { ResponseCardRuntime } from "../../src/channel/response-card"
import {
  collectChannelTaskTerminals,
  deliverForegroundTaskTerminal,
  replyChannelTaskAttachments,
} from "../../src/channel/outbound-parts"
import { Asset } from "../../src/asset/asset"
import type { OutboundPart, Provider, ResponseCard } from "../../src/channel/types"
import { Identifier } from "../../src/id/id"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for channel delivery")
    await Bun.sleep(10)
  }
}

function initOutbound() {
  return ChannelOutbound.init({ getProvider: Channel.getProvider })
}

type ProviderCalls = {
  replies: string[]
  pushes: string[]
  replyParts?: OutboundPart[][]
  pushParts?: OutboundPart[][]
  responseCards?: Array<{
    accountId: string
    chatId: string
    chatType?: "dm" | "group"
    scopeKey?: string
    replyToMessageId?: string
    requestId: string
    card: ResponseCard
  }>
}

function provider(type: string, calls: ProviderCalls): Provider {
  return {
    type,
    lifecycle: "self_connected",
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
    async sendResponseCard(input) {
      calls.responseCards?.push(input)
      return { messageId: "response_card_sent" }
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

const responseCard: ResponseCard = {
  title: "Deploy release",
  elements: [{ type: "button", id: "deploy", label: "Deploy", value: "production" }],
}

async function completedResponseCardRequest(input: {
  sessionID: string
  requesterId: string
  metadata: Record<string, unknown>
}) {
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
    metadata: { channelRequesterId: input.requesterId },
  } as MessageV2.User)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: rootID,
    sessionID: input.sessionID,
    type: "text",
    text: "Offer deployment choices",
  })

  const toolMessage = await completedAssistant(input.sessionID, "", "tool-calls", {}, rootID, false)
  const requestId = Identifier.ascending("part")
  await Session.updatePart({
    id: requestId,
    messageID: toolMessage.id,
    sessionID: input.sessionID,
    type: "tool",
    callID: "call_response_card",
    tool: "response_card",
    state: {
      status: "completed",
      input: responseCard,
      output: "Prepared response card",
      title: responseCard.title,
      metadata: { intent: { type: "response_card", card: responseCard } },
      time: { start: Date.now(), end: Date.now() },
    },
  })

  const terminalInfo = await completedAssistant(input.sessionID, "", "stop", input.metadata, rootID, false)
  return {
    requestId,
    terminal: await MessageV2.get({ sessionID: input.sessionID, messageID: terminalInfo.id }),
  }
}

test("replies async channel output to the persisted message anchor exactly once", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const type = `outbound-reply-${crypto.randomUUID()}`
      const calls = { replies: [] as string[], pushes: [] as string[] }
      Channel.registerProvider(provider(type, calls))
      const dispose = initOutbound()
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

test("initializes the outbound bridge independently for each Scope", async () => {
  await using first = await tmpdir({ git: true })
  await using second = await tmpdir({ git: true })
  const firstScope = await first.scope()
  const secondScope = await second.scope()
  let disposeFirst: (() => void) | undefined
  let disposeSecond: (() => void) | undefined

  try {
    await ScopeContext.provide({
      scope: firstScope,
      fn: async () => {
        disposeFirst = initOutbound()
      },
    })

    const calls = { replies: [] as string[], pushes: [] as string[] }
    await ScopeContext.provide({
      scope: secondScope,
      fn: async () => {
        const type = `outbound-second-scope-${crypto.randomUUID()}`
        Channel.registerProvider(provider(type, calls))
        disposeSecond = initOutbound()
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({ type, accountId: "acct_test", chatId: "chat_test" }),
        })

        await completedAssistant(session.id, "Second Scope result")
        await waitFor(() => calls.replies.length > 0)
      },
    })

    expect(calls.replies).toEqual(["msg_topic_root"])
  } finally {
    disposeSecond?.()
    disposeFirst?.()
  }
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
      const dispose = initOutbound()
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
      const dispose = initOutbound()
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
      const dispose = initOutbound()
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
      const dispose = initOutbound()
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
      const dispose = initOutbound()
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
      const dispose = initOutbound()
      try {
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({ type, accountId: "acct_test", chatId: "chat_test" }),
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

test("does not re-deliver already-delivered task attachments on a later terminal reply in the same root", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const type = `outbound-root-dedup-${crypto.randomUUID()}`
      const calls: ProviderCalls = { replies: [], pushes: [], replyParts: [], pushParts: [] }
      Channel.registerProvider(provider(type, calls))
      const dispose = initOutbound()
      try {
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({ type, accountId: "acct_test", chatId: "chat_test" }),
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
        } as MessageV2.User)
        const assetID = await Asset.write(Buffer.from([137, 80, 78, 71]), "image/png", "preview.png")
        await completedToolAttachment({
          sessionID: session.id,
          rootID,
          assetID,
          mime: "image/png",
          filename: "preview.png",
        })

        await completedAssistant(session.id, "First reply", "stop", undefined, rootID)
        await waitFor(() => (calls.replyParts?.length ?? 0) === 1)
        // Wait for the delivery record to be durable on the root message
        // before the second terminal arrives, mirroring a later wake-up.
        await waitFor(async () => {
          const root = await MessageV2.get({ sessionID: session.id, messageID: rootID }).catch(() => undefined)
          return Array.isArray(root?.info.metadata?.channelOutboundAttachmentUrls)
        })

        await completedAssistant(
          session.id,
          "Second reply",
          "stop",
          { channelPush: true, channelReply: true, channelReplyToMessageId: "msg_topic_root" },
          rootID,
        )
        await waitFor(() => (calls.replyParts?.length ?? 0) === 2)

        expect(calls.replyParts).toEqual([
          [
            { type: "text", text: "First reply" },
            {
              type: "image",
              path: Asset.resolvePath(assetID),
              filename: "preview.png",
              contentType: "image/png",
            },
          ],
          [{ type: "text", text: "Second reply" }],
        ])
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

test("delivers a card-only async channel result once and marks the terminal outbound complete", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const type = `outbound-response-card-${crypto.randomUUID()}`
      const calls: ProviderCalls = { replies: [], pushes: [], responseCards: [] }
      Channel.registerProvider(provider(type, calls))
      const dispose = initOutbound()
      try {
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({
            type,
            accountId: "acct_test",
            chatId: "chat_test",
            chatType: "group",
            scopeKey: "chat_test:message:msg_topic_root",
          }),
        })
        const task = await completedResponseCardRequest({
          sessionID: session.id,
          requesterId: "requester_test",
          metadata: {
            channelPush: true,
            channelReply: true,
            channelReplyToMessageId: "msg_topic_root",
          },
        })

        await waitFor(() => calls.responseCards?.length === 1)
        expect(calls.responseCards).toEqual([
          {
            accountId: "acct_test",
            chatId: "chat_test",
            chatType: "group",
            scopeKey: "chat_test:message:msg_topic_root",
            replyToMessageId: "msg_topic_root",
            requestId: task.requestId,
            card: responseCard,
          },
        ])
        expect(calls.replies).toEqual([])
        expect(calls.pushes).toEqual([])

        const persisted = await MessageV2.get({
          sessionID: session.id,
          messageID: task.terminal.info.id,
        })
        expect(persisted.info.metadata?.channelOutboundSent).toBe(true)

        await Promise.all([
          Bus.publish(MessageV2.Event.Updated, { info: task.terminal.info }),
          Bus.publish(MessageV2.Event.Updated, { info: task.terminal.info }),
        ])
        await Bun.sleep(25)
        expect(calls.responseCards).toHaveLength(1)
      } finally {
        dispose()
      }
    },
  })
})

test("marks a card-only async result complete when foreground delivery already registered the card", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const type = `outbound-response-card-race-${crypto.randomUUID()}`
      const calls: ProviderCalls = { replies: [], pushes: [], responseCards: [] }
      const adapter = provider(type, calls)
      Channel.registerProvider(adapter)
      const session = await Session.create({
        endpoint: SessionEndpoint.fromChannel({ type, accountId: "acct_test", chatId: "chat_test" }),
      })
      const task = await completedResponseCardRequest({
        sessionID: session.id,
        requesterId: "requester_test",
        metadata: {
          channelPush: true,
          channelReply: true,
          channelReplyToMessageId: "msg_topic_root",
        },
      })

      expect(
        await ResponseCardRuntime.deliverTaskCards({
          provider: adapter,
          accountId: "acct_test",
          chatId: "chat_test",
          replyToMessageId: "msg_topic_root",
          sessionID: session.id,
          terminal: task.terminal,
        }),
      ).toBe(true)
      expect(calls.responseCards).toHaveLength(1)

      const dispose = initOutbound()
      try {
        await Bus.publish(MessageV2.Event.Updated, { info: task.terminal.info })
        await waitFor(async () => {
          const current = await MessageV2.get({
            sessionID: session.id,
            messageID: task.terminal.info.id,
          })
          return current.info.metadata?.channelOutboundSent === true
        })
        expect(calls.responseCards).toHaveLength(1)
        expect(calls.replies).toEqual([])
        expect(calls.pushes).toEqual([])
      } finally {
        dispose()
      }
    },
  })
})

test("skips the outbound bridge while a foreground streaming session owns the root", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const type = `outbound-foreground-${crypto.randomUUID()}`
      const calls = { replies: [] as string[], pushes: [] as string[] }
      Channel.registerProvider(provider(type, calls))
      const dispose = initOutbound()
      try {
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({
            type,
            accountId: "acct_test",
            chatId: "chat_test",
          }),
        })
        const rootID = Identifier.ascending("message")

        // The foreground streaming card owns this root's reply.
        ChannelOutbound.beginForeground(session.id, rootID)
        const assistant = await completedAssistant(
          session.id,
          "Streaming answer",
          "stop",
          {
            channelPush: true,
            channelReply: true,
            channelReplyToMessageId: "msg_topic_root",
          },
          rootID,
        )
        await Bun.sleep(25)
        expect(calls.replies).toEqual([])
        expect(calls.pushes).toEqual([])

        // Once the streaming session closes, the durable marker is persisted
        // and the bridge stays silent for later metadata updates.
        await Session.mergeMessageMetadata({
          sessionID: session.id,
          messageID: assistant.id,
          metadata: { channelOutboundSent: true },
        })
        await Promise.all([
          Bus.publish(MessageV2.Event.Updated, { info: assistant }),
          Bus.publish(MessageV2.Event.Updated, { info: assistant }),
        ])
        await Bun.sleep(25)
        expect(calls.replies).toEqual([])
        expect(calls.pushes).toEqual([])

        // A root not owned by a foreground session still reaches the bridge.
        const secondRootID = Identifier.ascending("message")
        await completedAssistant(
          session.id,
          "Queued answer",
          "stop",
          {
            channelPush: true,
            channelReply: true,
            channelReplyToMessageId: "msg_topic_root",
          },
          secondRootID,
        )
        await waitFor(() => calls.replies.length === 1)
        expect(calls.replies).toEqual(["msg_topic_root"])
      } finally {
        dispose()
      }
    },
  })
})

test("foreground registration ends so the bridge resumes delivery for the same root", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const type = `outbound-foreground-end-${crypto.randomUUID()}`
      const calls = { replies: [] as string[], pushes: [] as string[] }
      Channel.registerProvider(provider(type, calls))
      const dispose = initOutbound()
      try {
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({
            type,
            accountId: "acct_test",
            chatId: "chat_test",
          }),
        })
        const rootID = Identifier.ascending("message")
        ChannelOutbound.beginForeground(session.id, rootID)
        const assistant = await completedAssistant(
          session.id,
          "Streaming answer",
          "stop",
          {
            channelPush: true,
            channelReply: true,
            channelReplyToMessageId: "msg_topic_root",
          },
          rootID,
        )
        await Bun.sleep(25)
        expect(calls.replies).toEqual([])

        // The foreground streaming session ended without persisting the sent
        // marker (e.g. the card failed to close). The bridge must still deliver
        // the terminal reply so the user is not left without an answer.
        ChannelOutbound.endForeground(session.id, rootID)
        await Bus.publish(MessageV2.Event.Updated, { info: assistant })
        await waitFor(() => calls.replies.length === 1)
        expect(calls.replies).toEqual(["msg_topic_root"])
      } finally {
        dispose()
      }
    },
  })
})

test("delivers a foreground-completed terminal that the loop did not return", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const calls: ProviderCalls = { replies: [], pushes: [], replyParts: [], pushParts: [] }
      const session = await Session.create({
        endpoint: SessionEndpoint.fromChannel({
          type: `foreground-compensate-${crypto.randomUUID()}`,
          accountId: "acct_test",
          chatId: "chat_test",
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
      } as MessageV2.User)
      const assetID = await Asset.write(Buffer.from([137, 80, 78, 71]), "image/png", "preview.png")
      await completedToolAttachment({
        sessionID: session.id,
        rootID,
        assetID,
        mime: "image/png",
        filename: "preview.png",
      })

      // Snapshot before the terminal exists, then complete the terminal:
      // the foreground invoke returned a different (later) terminal, so this
      // one must be delivered by the compensation path.
      const terminalsBefore = await collectChannelTaskTerminals(session.id)
      const terminal = await completedAssistant(
        session.id,
        "Compensated reply",
        "stop",
        { channelPush: true, channelReply: true, channelReplyToMessageId: "msg_topic_root" },
        rootID,
      )

      expect(
        await deliverForegroundTaskTerminal({
          provider: provider("foreground-compensate", calls),
          accountId: "acct_test",
          messageId: "msg_topic_root",
          chatId: "chat_test",
          sessionID: session.id,
          currentRootID: rootID,
          excludeTerminalID: "msg_other_terminal",
          terminalsBefore,
        }),
      ).toBe(true)

      expect(calls.replies).toEqual(["msg_topic_root"])
      expect(calls.replyParts).toEqual([
        [
          { type: "text", text: "Compensated reply" },
          {
            type: "image",
            path: Asset.resolvePath(assetID),
            filename: "preview.png",
            contentType: "image/png",
          },
        ],
      ])

      const persisted = await MessageV2.get({ sessionID: session.id, messageID: terminal.id })
      expect(persisted.info.metadata?.channelOutboundSent).toBe(true)
      const root = await MessageV2.get({ sessionID: session.id, messageID: rootID })
      expect(root.info.metadata?.channelOutboundAttachmentUrls).toEqual([`asset://${assetID}`])
    },
  })
})

test("does not re-deliver a terminal already present before the invoke", async () => {
  await using tmp = await tmpdir({ git: true })
  await ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      const calls: ProviderCalls = { replies: [], pushes: [], replyParts: [], pushParts: [] }
      const session = await Session.create({
        endpoint: SessionEndpoint.fromChannel({
          type: `foreground-compensate-skip-${crypto.randomUUID()}`,
          accountId: "acct_test",
          chatId: "chat_test",
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
      } as MessageV2.User)
      const terminal = await completedAssistant(session.id, "Already delivered", "stop", {}, rootID)

      const terminalsBefore = await collectChannelTaskTerminals(session.id)
      expect(
        await deliverForegroundTaskTerminal({
          provider: provider("foreground-compensate-skip", calls),
          accountId: "acct_test",
          messageId: "msg_topic_root",
          sessionID: session.id,
          currentRootID: rootID,
          excludeTerminalID: "msg_other_terminal",
          terminalsBefore,
        }),
      ).toBe(false)
      expect(calls.replies).toEqual([])

      // The excluded (loop result) terminal is never delivered either.
      expect(
        await deliverForegroundTaskTerminal({
          provider: provider("foreground-compensate-skip", calls),
          accountId: "acct_test",
          messageId: "msg_topic_root",
          sessionID: session.id,
          currentRootID: rootID,
          excludeTerminalID: terminal.id,
          terminalsBefore: new Map(),
        }),
      ).toBe(false)
      expect(calls.replies).toEqual([])
    },
  })
})
