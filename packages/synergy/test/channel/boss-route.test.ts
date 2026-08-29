import { afterEach, describe, expect, mock, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionInteraction } from "../../src/session/interaction"
import { SessionInbox } from "../../src/session/inbox"
import { SessionManager } from "../../src/session/manager"
import { BossRuntime } from "../../src/boss/boss-runtime"
import { Channel } from "../../src/channel"
import { Config } from "../../src/config/config"
import type { Provider, StreamingSession } from "../../src/channel/types"
import type { ChannelHost } from "../../src/channel/host"

const originalConfigCurrent = Config.current
const ACCOUNT_ID = "acct_boss"

/**
 * Runtime Boss Mode Feishu routing contract (handleMessage seam):
 * when the account's boss session is registered, every accepted group/DM
 * message is normalized to the `scope:boss` endpoint (one session), carries a
 * source header + source metadata, and its reply is anchored to the original
 * message. Disabling the flag restores per-chat sessions and leaves the boss
 * session untouched. Accounts with a projectDir are fail-closed.
 */
describe("Feishu boss routing", () => {
  afterEach(async () => {
    Config.current = originalConfigCurrent
    await BossRuntime.sync(false).catch(() => {})
    await ScopeContext.provide({ scope: Scope.home(), fn: () => Channel.stopAll() }).catch(() => {})
    // Remove any boss sessions left in home scope so each test starts clean.
    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const sessions: Session.Info[] = []
        for await (const s of Session.listAll()) sessions.push(s)
        for (const s of sessions) {
          if (s.workflow?.kind === "boss" && s.workflow.role === "boss" && s.endpoint?.kind === "channel") {
            await Session.remove(s.id).catch(() => {})
          }
        }
      },
    }).catch(() => {})
  })

  function bossConfig(accountOverrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      channel: {
        feishu: {
          type: "feishu",
          streaming: false,
          responseFormat: "text",
          accounts: {
            [ACCOUNT_ID]: {
              appId: "a",
              appSecret: "b",
              enabled: true,
              ...accountOverrides,
            },
          },
        },
      },
      experimental: { boss_mode: true },
    }
  }

  function stubConfig(partial: Record<string, unknown>): void {
    Config.current = mock(async () => Config.Info.parse(partial as unknown as Config.Info)) as typeof Config.current
  }

  const streaming = (): StreamingSession => ({
    async start() {},
    async update() {},
    async updateToolProgress() {},
    async close() {},
    isActive: () => false,
    ownsTerminalDelivery: () => true,
  })

  /** Register a self-connected fake Feishu provider that captures the host. */
  async function connectHost(): Promise<ChannelHost.Instance> {
    let host: ChannelHost.Instance | undefined
    const provider = {
      type: "feishu",
      lifecycle: "self_connected" as const,
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
      async connect(input: Parameters<Provider["connect"]>[0]) {
        host = input.host
      },
    } satisfies Provider
    Channel.registerProvider(provider)

    await Channel.reload()
    await Channel.init()
    const deadline = Date.now() + 2_000
    while (!host && Date.now() < deadline) await Bun.sleep(5)
    if (!host) throw new Error("fake feishu provider did not connect")
    return host
  }

  test("routes accepted group and DM messages into the one runtime boss session with source metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    stubConfig(bossConfig())

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        await BossRuntime.ensure()
        const bossID = BossRuntime.bossSessionForAccount(ACCOUNT_ID)
        expect(bossID).toBeDefined()
        if (!bossID) throw new Error("expected a boss session")
        const boss = await Session.get(bossID)
        expect(boss.workflow).toEqual({ kind: "boss", role: "boss" })

        // Hold the boss lease so every routed message is durably queued
        // instead of executing an LLM turn.
        const lease = SessionManager.acquire(bossID)
        expect(lease).toBeDefined()
        if (!lease) throw new Error("expected to acquire the boss lease")
        try {
          const host = await connectHost()
          const timestamp = Date.now()
          const messages = [
            {
              chatId: "oc_group_a",
              chatType: "group" as const,
              chatName: "项目A群",
              senderId: "ou_a",
              senderName: "小明",
              text: "你好 boss",
              messageId: "om_msg_a",
              timestamp,
            },
            {
              chatId: "oc_group_b",
              chatType: "group" as const,
              chatName: "项目B群",
              senderId: "ou_b",
              senderName: "小红",
              text: "帮忙看一下",
              messageId: "om_msg_b",
              // Replying to an earlier message must not change the anchor:
              // boss routing forces the reply to the current message.
              replyToMessageId: "om_prev",
              timestamp,
            },
            {
              chatId: "oc_dm_1",
              chatType: "dm" as const,
              chatName: "Alice",
              senderId: "ou_alice",
              senderName: "Alice",
              text: "私聊消息",
              messageId: "om_msg_c",
              timestamp,
            },
          ]
          for (const message of messages) {
            await host.conversations.receive({ ...message })
          }

          const items = (await SessionInbox.list(bossID)).filter((item) => item.deliveryKey?.startsWith("channel:"))
          expect(items).toHaveLength(3)
          const byMessageID = new Map(messages.map((m) => [m.messageId, m]))
          for (const item of items) {
            expect(item.sessionID).toBe(bossID)
            const expected = byMessageID.get(item.deliveryKey!.split(":").pop()!)
            expect(expected).toBeDefined()
            if (!expected) continue
            expect(item.message?.metadata).toMatchObject({
              channelReply: true,
              channelReplyToMessageId: expected.messageId,
              channelChatId: expected.chatId,
              channelChatName: expected.chatName,
              channelSenderId: expected.senderId,
              channelSenderName: expected.senderName,
            })
            const textPart = item.message?.parts.find((part) => part.type === "text")
            expect(textPart?.type).toBe("text")
            if (textPart?.type === "text") {
              expect(textPart.text).toContain(`[群: ${expected.chatName} | 发送者: ${expected.senderName} | `)
              expect(textPart.text).toContain(expected.text)
            }
          }

          // The boss session must keep its boss interaction and provisioned
          // display name after routing (multi-chat aggregation must not flap
          // the chatName to whichever chat messaged last).
          const after = await Session.get(bossID)
          expect(after.interaction).toEqual({ mode: "interactive", source: "boss" })
          if (after.endpoint?.kind === "channel") {
            expect(after.endpoint.channel.chatName).toBe("Runtime Boss")
          }
        } finally {
          await SessionManager.release(lease, { requestNextWork: false })
        }
      },
    })
  })

  test("disabling boss mode restores per-chat session routing and leaves the boss session untouched", async () => {
    await using tmp = await tmpdir({ git: true })
    stubConfig(bossConfig())

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        await BossRuntime.ensure()
        const bossID = BossRuntime.bossSessionForAccount(ACCOUNT_ID)
        expect(bossID).toBeDefined()
        if (!bossID) throw new Error("expected a boss session")

        const bossLease = SessionManager.acquire(bossID)
        expect(bossLease).toBeDefined()
        if (!bossLease) throw new Error("expected to acquire the boss lease")
        try {
          const host = await connectHost()
          await BossRuntime.sync(false)

          // Pre-bind the per-chat session (what getOrCreateForEndpoint would
          // create) and hold its lease so the message is durably queued there.
          const chatEndpoint = SessionEndpoint.fromChannel({
            type: "feishu",
            accountId: ACCOUNT_ID,
            chatId: "oc_group_x",
            chatType: "group",
            chatName: "普通群",
            createdAt: Date.now(),
          })
          const chatSession = await Session.create({
            scope: Scope.home(),
            endpoint: chatEndpoint,
            interaction: SessionInteraction.interactive("channel:feishu"),
          })
          const chatLease = SessionManager.acquire(chatSession.id)
          expect(chatLease).toBeDefined()
          if (!chatLease) throw new Error("expected to acquire the chat lease")
          try {
            await host.conversations.receive({
              chatId: "oc_group_x",
              chatType: "group",
              chatName: "普通群",
              senderId: "ou_x",
              senderName: "小王",
              text: "未路由消息",
              messageId: "om_msg_x",
              timestamp: Date.now(),
            })

            const chatItems = await SessionInbox.list(chatSession.id)
            expect(chatItems).toHaveLength(1)
            const item = chatItems[0]
            expect(item?.sessionID).toBe(chatSession.id)
            expect(item?.message?.metadata).toMatchObject({
              channelReplyToMessageId: "om_msg_x",
              channelChatId: "oc_group_x",
            })
            const textPart = item?.message?.parts.find((part) => part.type === "text")
            expect(textPart?.type).toBe("text")
            if (textPart?.type === "text") {
              expect(textPart.text).not.toContain("[群:")
              expect(textPart.text).toContain("未路由消息")
            }

            // The boss session is untouched: no channel delivery, still alive.
            const bossItems = await SessionInbox.list(bossID)
            expect(bossItems.some((i) => i.deliveryKey?.startsWith("channel:"))).toBe(false)
            expect(await Session.get(bossID)).toBeDefined()
          } finally {
            await SessionManager.release(chatLease, { requestNextWork: false })
          }
        } finally {
          await SessionManager.release(bossLease, { requestNextWork: false })
        }
      },
    })
  })

  test("accounts with a projectDir are fail-closed: no boss session is provisioned", async () => {
    await using tmp = await tmpdir({ git: true })
    stubConfig(bossConfig({ projectDir: "/tmp/some-project" }))

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        await BossRuntime.ensure()
        expect(BossRuntime.bossSessionForAccount(ACCOUNT_ID)).toBeUndefined()
      },
    })
  })
})
