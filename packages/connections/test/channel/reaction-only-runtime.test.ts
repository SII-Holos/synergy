import { afterAll as afterRuntimeTests, describe, expect, test } from "bun:test"
import { Channel } from "../../src/channel"
import { ChannelOutbound } from "../../src/channel/outbound"
import {
  findReactionOnlyIntent,
  reactionOnlyResolved,
  reactionOnlyRootResolved,
  resolveReactionTarget,
} from "../../src/channel/reaction-only-runtime"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionEndpoint } from "@ericsanchezok/synergy-harness/session/endpoint"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import type { Provider } from "../../src/channel/types"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()

const REACTION_TOOL = "channel_reaction_only"

/** Channel delivery tests need the runtime context for provider and outbound state. */
function deliveryTest(name: string, fn: () => Promise<void>) {
  test(name, () => runtime.run(fn))
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for channel delivery")
    await Bun.sleep(10)
  }
}

type Calls = {
  reactions: Array<{ accountId: string; messageId: string; emoji: string }>
  replies: string[]
  pushes: string[]
}

function provider(type: string, calls: Calls, options: { failReaction?: boolean; canReact?: boolean } = {}): Provider {
  const value: Provider = {
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
  if (options.canReact !== false) {
    value.addReaction = async (input) => {
      if (options.failReaction) throw new Error("reaction rejected by provider")
      calls.reactions.push(input)
      return { reactionId: "reaction_1" }
    }
  }
  return value
}

/** Root user message carrying the inbound Feishu message id for this turn. */
async function channelRoot(input: { sessionID: string; inboundId?: string }) {
  const id = Identifier.ascending("message")
  await Session.updateMessage({
    id,
    sessionID: input.sessionID,
    role: "user",
    isRoot: true,
    rootID: id,
    agent: "synergy",
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
    metadata: {
      channelRequesterId: "ou_user",
      ...(input.inboundId ? { channelInboundMessageId: input.inboundId } : {}),
    },
  } as MessageV2.User)
  return id
}

async function assistant(
  sessionID: string,
  input: { rootID: string; text?: string; finish?: string; metadata?: Record<string, unknown> },
) {
  const created = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    parentID: input.rootID,
    rootID: input.rootID,
    mode: "synergy",
    agent: "synergy",
    path: { cwd: ScopeContext.current.directory, root: ScopeContext.current.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "test-model",
    providerID: "test-provider",
    time: { created: Date.now() },
    sessionID,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  } as MessageV2.Assistant)) as MessageV2.Assistant
  if (input.text) {
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: created.id,
      sessionID,
      type: "text",
      text: input.text,
    })
  }
  return (await Session.updateMessage({
    ...created,
    finish: input.finish ?? "stop",
    time: { ...created.time, completed: Date.now() },
  })) as MessageV2.Assistant
}

/** Completed reaction-only tool part, i.e. what the tool persists. */
async function reactionOnlyRequest(input: { sessionID: string; rootID: string; reaction: string }) {
  const toolMessage = await assistant(input.sessionID, { rootID: input.rootID, finish: "tool-calls" })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: toolMessage.id,
    sessionID: input.sessionID,
    type: "tool",
    callID: "call_reaction_only",
    tool: REACTION_TOOL,
    state: {
      status: "completed",
      input: {},
      output: `Ending this turn with the "${input.reaction}" reaction.`,
      title: `Reaction only: ${input.reaction}`,
      metadata: { intent: { type: "reaction_only", reaction: input.reaction } },
      time: { start: Date.now(), end: Date.now() },
    },
  })
}

const replyMetadata = {
  channelPush: true,
  channelReply: true,
  channelReplyToMessageId: "msg_topic_root",
}

describe("Channel reaction-only terminal delivery", () => {
  deliveryTest("reacts to the inbound message and posts no reply, push, or card", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const type = `reaction-only-${crypto.randomUUID()}`
        const calls: Calls = { reactions: [], replies: [], pushes: [] }
        Channel.registerProvider(provider(type, calls))
        const dispose = ChannelOutbound.init({ getProvider: Channel.getProvider })
        try {
          const session = await Session.create({
            endpoint: SessionEndpoint.fromChannel({ type, accountId: "acct_test", chatId: "chat_test" }),
          })
          const rootID = await channelRoot({ sessionID: session.id, inboundId: "om_inbound" })
          await reactionOnlyRequest({ sessionID: session.id, rootID, reaction: "SILENT" })
          await assistant(session.id, { rootID, metadata: replyMetadata })

          await waitFor(() => calls.reactions.length > 0)
          await Bun.sleep(25)

          expect(calls.reactions).toEqual([{ accountId: "acct_test", messageId: "om_inbound", emoji: "SILENT" }])
          expect(calls.replies).toEqual([])
          expect(calls.pushes).toEqual([])
        } finally {
          dispose()
        }
      },
    })
  })

  deliveryTest("reacts to the inbound message even when the reply anchors to a topic root", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const type = `reaction-only-thread-${crypto.randomUUID()}`
        const calls: Calls = { reactions: [], replies: [], pushes: [] }
        Channel.registerProvider(provider(type, calls))
        const dispose = ChannelOutbound.init({ getProvider: Channel.getProvider })
        try {
          const session = await Session.create({
            endpoint: SessionEndpoint.fromChannel({ type, accountId: "acct_test", chatId: "chat_test" }),
          })
          const rootID = await channelRoot({ sessionID: session.id, inboundId: "om_reply_in_topic" })
          await reactionOnlyRequest({ sessionID: session.id, rootID, reaction: "DONE" })
          await assistant(session.id, { rootID, metadata: replyMetadata })

          await waitFor(() => calls.reactions.length > 0)
          await Bun.sleep(25)

          // Reply anchor is the topic root; the reaction must still target the
          // user's own message and no thread is created by reacting.
          expect(calls.reactions).toEqual([{ accountId: "acct_test", messageId: "om_reply_in_topic", emoji: "DONE" }])
          expect(calls.replies).toEqual([])
        } finally {
          dispose()
        }
      },
    })
  })

  deliveryTest("falls back to the reply anchor when the inbound id was not recorded", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const type = `reaction-only-fallback-${crypto.randomUUID()}`
        const calls: Calls = { reactions: [], replies: [], pushes: [] }
        Channel.registerProvider(provider(type, calls))
        const dispose = ChannelOutbound.init({ getProvider: Channel.getProvider })
        try {
          const session = await Session.create({
            endpoint: SessionEndpoint.fromChannel({ type, accountId: "acct_test", chatId: "chat_test" }),
          })
          const rootID = await channelRoot({ sessionID: session.id })
          await reactionOnlyRequest({ sessionID: session.id, rootID, reaction: "SILENT" })
          await assistant(session.id, { rootID, metadata: replyMetadata })

          await waitFor(() => calls.reactions.length > 0)
          expect(calls.reactions[0]?.messageId).toBe("msg_topic_root")
        } finally {
          dispose()
        }
      },
    })
  })

  deliveryTest("records a failure instead of degrading into a text reply", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const type = `reaction-only-failure-${crypto.randomUUID()}`
        const calls: Calls = { reactions: [], replies: [], pushes: [] }
        Channel.registerProvider(provider(type, calls, { failReaction: true }))
        const dispose = ChannelOutbound.init({ getProvider: Channel.getProvider })
        try {
          const session = await Session.create({
            endpoint: SessionEndpoint.fromChannel({ type, accountId: "acct_test", chatId: "chat_test" }),
          })
          const rootID = await channelRoot({ sessionID: session.id, inboundId: "om_inbound" })
          await reactionOnlyRequest({ sessionID: session.id, rootID, reaction: "SILENT" })
          const terminal = await assistant(session.id, { rootID, text: "explaining", metadata: replyMetadata })

          await waitFor(async () => {
            const current = await MessageV2.get({ sessionID: session.id, messageID: terminal.id })
            return current.info.metadata?.channelReactionOnlyError === "SILENT"
          })
          await Bun.sleep(25)

          // A failed reaction must never be converted into a text answer and
          // must not be marked delivered.
          expect(calls.replies).toEqual([])
          expect(calls.pushes).toEqual([])
          const current = await MessageV2.get({ sessionID: session.id, messageID: terminal.id })
          expect(current.info.metadata?.channelReactionOnlyError).toBe("SILENT")
          expect(current.info.metadata?.channelOutboundSent).toBeUndefined()
          expect(current.info.metadata?.channelReactionOnlyDelivered).toBeUndefined()
        } finally {
          dispose()
        }
      },
    })
  })

  deliveryTest("does not retry a reaction-only turn that already resolved", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const type = `reaction-only-resolved-${crypto.randomUUID()}`
        const calls: Calls = { reactions: [], replies: [], pushes: [] }
        Channel.registerProvider(provider(type, calls))
        const dispose = ChannelOutbound.init({ getProvider: Channel.getProvider })
        try {
          const session = await Session.create({
            endpoint: SessionEndpoint.fromChannel({ type, accountId: "acct_test", chatId: "chat_test" }),
          })
          const rootID = await channelRoot({ sessionID: session.id, inboundId: "om_inbound" })
          await reactionOnlyRequest({ sessionID: session.id, rootID, reaction: "SILENT" })
          await assistant(session.id, {
            rootID,
            metadata: { ...replyMetadata, channelReactionOnlyDelivered: "SILENT" },
          })

          await Bun.sleep(50)
          expect(calls.reactions).toEqual([])
          expect(calls.replies).toEqual([])
        } finally {
          dispose()
        }
      },
    })
  })

  deliveryTest("keeps normal text delivery when no reaction-only intent exists", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const type = `reaction-only-normal-${crypto.randomUUID()}`
        const calls: Calls = { reactions: [], replies: [], pushes: [] }
        Channel.registerProvider(provider(type, calls))
        const dispose = ChannelOutbound.init({ getProvider: Channel.getProvider })
        try {
          const session = await Session.create({
            endpoint: SessionEndpoint.fromChannel({ type, accountId: "acct_test", chatId: "chat_test" }),
          })
          const rootID = await channelRoot({ sessionID: session.id, inboundId: "om_inbound" })
          await assistant(session.id, { rootID, text: "Here is the answer", metadata: replyMetadata })

          await waitFor(() => calls.replies.length > 0)
          expect(calls.replies).toEqual(["msg_topic_root"])
          expect(calls.reactions).toEqual([])
        } finally {
          dispose()
        }
      },
    })
  })
})

describe("Reaction-only intent helpers", () => {
  function message(input: {
    id: string
    rootID: string
    role: "user" | "assistant"
    parts: MessageV2.Part[]
    metadata?: Record<string, unknown>
  }): MessageV2.WithParts {
    return {
      info: {
        id: input.id,
        sessionID: "session_test",
        role: input.role,
        parentID: input.rootID,
        rootID: input.rootID,
        mode: "synergy",
        agent: "synergy",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: "test-model",
        providerID: "test-provider",
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
      parts: input.parts,
    } as MessageV2.WithParts
  }

  function toolPart(input: { id: string; messageID: string; tool: string; metadata: unknown }) {
    return {
      id: input.id,
      sessionID: "session_test",
      messageID: input.messageID,
      type: "tool",
      callID: `call_${input.id}`,
      tool: input.tool,
      state: {
        status: "completed",
        input: {},
        output: "ok",
        title: "t",
        metadata: input.metadata,
        time: { start: Date.now(), end: Date.now() },
      },
    } as MessageV2.ToolPart
  }

  test("finds a reaction-only intent from a completed tool part", () => {
    const messages = [
      message({
        id: "m1",
        rootID: "root",
        role: "assistant",
        parts: [
          toolPart({
            id: "p1",
            messageID: "m1",
            tool: REACTION_TOOL,
            metadata: { intent: { type: "reaction_only", reaction: "SILENT" } },
          }),
        ],
      }),
    ]
    expect(findReactionOnlyIntent(messages, "root")).toEqual({ reaction: "SILENT", partID: "p1" })
  })

  test("treats a root with a delivered or failed reaction-only turn as having no intent", () => {
    for (const marker of [{ channelReactionOnlyDelivered: "SILENT" }, { channelReactionOnlyError: "SILENT" }]) {
      const messages = [
        message({
          id: "m0",
          rootID: "root",
          role: "assistant",
          parts: [
            toolPart({
              id: "p0",
              messageID: "m0",
              tool: REACTION_TOOL,
              metadata: { intent: { type: "reaction_only", reaction: "SILENT" } },
            }),
          ],
          metadata: marker,
        }),
        message({
          id: "m1",
          rootID: "root",
          role: "assistant",
          parts: [
            toolPart({
              id: "p1",
              messageID: "m1",
              tool: REACTION_TOOL,
              metadata: { intent: { type: "reaction_only", reaction: "DONE" } },
            }),
          ],
        }),
      ]
      expect(findReactionOnlyIntent(messages, "root")).toBeUndefined()
      expect(reactionOnlyRootResolved(messages, "root")).toBe(true)
    }
  })

  test("ignores other tools, malformed intents, and other roots", () => {
    const messages = [
      message({
        id: "m1",
        rootID: "root",
        role: "assistant",
        parts: [
          toolPart({
            id: "p1",
            messageID: "m1",
            tool: "response_card",
            metadata: { intent: { type: "reaction_only", reaction: "SILENT" } },
          }),
          toolPart({ id: "p2", messageID: "m1", tool: REACTION_TOOL, metadata: { intent: { type: "nope" } } }),
          toolPart({ id: "p3", messageID: "m1", tool: REACTION_TOOL, metadata: { intent: { type: "reaction_only" } } }),
        ],
      }),
      message({
        id: "m2",
        rootID: "other",
        role: "assistant",
        parts: [
          toolPart({
            id: "p4",
            messageID: "m2",
            tool: REACTION_TOOL,
            metadata: { intent: { type: "reaction_only", reaction: "DONE" } },
          }),
        ],
      }),
    ]
    expect(findReactionOnlyIntent(messages, "root")).toBeUndefined()
    expect(findReactionOnlyIntent(messages, "other")).toEqual({ reaction: "DONE", partID: "p4" })
  })

  test("resolves the inbound message id with the reply anchor as fallback", () => {
    const messages = [
      message({
        id: "root",
        rootID: "root",
        role: "user",
        parts: [],
        metadata: { channelInboundMessageId: "om_inbound" },
      }),
      message({ id: "m1", rootID: "root", role: "assistant", parts: [] }),
    ]
    expect(resolveReactionTarget(messages, "root", "msg_anchor")).toBe("om_inbound")

    const withoutInbound = [message({ id: "root", rootID: "root", role: "user", parts: [] })]
    expect(resolveReactionTarget(withoutInbound, "root", "msg_anchor")).toBe("msg_anchor")
    expect(resolveReactionTarget(withoutInbound, "root", undefined)).toBeUndefined()
  })

  test("treats delivered and failed turns as resolved", () => {
    const base = message({ id: "m1", rootID: "root", role: "assistant", parts: [] })
    const asAssistant = (metadata: Record<string, unknown> | undefined) =>
      ({ ...base.info, metadata }) as unknown as MessageV2.Assistant
    expect(reactionOnlyResolved(asAssistant({ channelReactionOnlyDelivered: "SILENT" }))).toBe(true)
    expect(reactionOnlyResolved(asAssistant({ channelReactionOnlyError: "SILENT" }))).toBe(true)
    expect(reactionOnlyResolved(asAssistant({ channelOutboundSent: true }))).toBe(false)
    expect(reactionOnlyResolved(asAssistant(undefined))).toBe(false)
  })
})

afterRuntimeTests(() => runtime.close())
