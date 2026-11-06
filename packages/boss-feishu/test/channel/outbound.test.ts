import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { expect, test } from "bun:test"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { Channel } from "@ericsanchezok/synergy-channels/channel"
import { ChannelOutbound } from "@ericsanchezok/synergy-channels/channel/outbound"
import { ResponseCardRuntime } from "@ericsanchezok/synergy-channels/channel/response-card"
import { replyChannelTaskAttachments } from "@ericsanchezok/synergy-channels/channel/outbound-parts"
import { Asset } from "@ericsanchezok/synergy-harness/asset/asset"
import type { OutboundPart, Provider, ResponseCard } from "@ericsanchezok/synergy-channels/channel/types"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { WorkflowSessionService } from "@ericsanchezok/synergy-boss/session/workflow"
import { SessionEndpoint } from "@ericsanchezok/synergy-harness/session/endpoint"
import { MessageV2 } from "@ericsanchezok/synergy-harness/session/message-v2"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

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
        async closeWithoutDelivery() {},
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
  rootID ??= Identifier.ascending("message")
  await Session.updateMessage({
    id: rootID,
    rootID,
    isRoot: true,
    sessionID,
    role: "user",
    origin: { type: "user" },
    visible: true,
    includeInContext: true,
    agent: PrimaryAgentIdentity.names.general,
    model: { providerID: "test-provider", modelID: "test-model" },
    time: { created: Date.now() },
  })
  const created = (await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    parentID: rootID,
    mode: PrimaryAgentIdentity.names.general,
    agent: PrimaryAgentIdentity.names.general,
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

test("never auto-delivers boss-role session terminals through the bridge (R6 explicit channel_push only)", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const type = `outbound-boss-skip-${crypto.randomUUID()}`
        const calls: ProviderCalls = { replies: [], pushes: [] }
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
          await WorkflowSessionService.enableBoss(session.id)

          // A terminal assistant reply with full channel delivery metadata would
          // be auto-delivered for a normal channel session; boss-role sessions
          // must never reach the provider — the boss replies via channel_push.
          await completedAssistant(session.id, "Boss terminal reply", "stop", {
            channelPush: true,
            channelReply: true,
            channelReplyToMessageId: "msg_topic_root",
          })
          await Bun.sleep(100)
          expect(calls.replies).toEqual([])
          expect(calls.pushes).toEqual([])
        } finally {
          dispose()
        }
      },
    })
  }))

test("non-boss channel sessions keep the automatic bridge reply (R6 regression guard)", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const type = `outbound-nonboss-${crypto.randomUUID()}`
        const calls: ProviderCalls = { replies: [], pushes: [] }
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

          await completedAssistant(session.id, "Ordinary reply", "stop", {
            channelPush: true,
            channelReply: true,
            channelReplyToMessageId: "msg_topic_root",
          })
          await waitFor(() => calls.replies.length > 0)
          expect(calls.replies).toEqual(["msg_topic_root"])
          expect(calls.pushes).toEqual([])
        } finally {
          dispose()
        }
      },
    })
  }))

afterRuntimeTests(() => runtime.close())
