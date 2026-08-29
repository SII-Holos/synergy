import { describe, expect, test } from "bun:test"
import { ChannelCommand } from "../../src/channel/command"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionManager } from "../../src/session/manager"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

// Product domains register workflows and tools via the L4 manifest
import "../../src/product-registration"

describe("ChannelCommand", () => {
  const endpointSuffix = crypto.randomUUID()
  const baseContext = {
    channelType: "feishu",
    accountId: `acct_test_${endpointSuffix}`,
    chatId: `chat_test_${endpointSuffix}`,
    chatType: "group" as const,
    chatName: "Synergy Dev",
    senderId: "user_test",
    senderName: "Maintainer",
    messageId: "msg_test",
  }

  async function workflowSession() {
    const session = await Session.findForEndpoint(
      SessionEndpoint.fromChannel({
        type: baseContext.channelType,
        accountId: baseContext.accountId,
        chatId: baseContext.chatId,
        senderId: baseContext.senderId,
      }),
      { scope: ScopeContext.current.scope },
    )
    if (!session) throw new Error("expected channel session")
    return session
  }

  test("handles bare /new with explicit confirmation", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await ChannelCommand.execute("/new", baseContext, ScopeContext.current.scope)
        expect(result).toEqual({
          action: "handled",
          reply: "✅ Started a new conversation. Send your next message when ready.",
        })
      },
    })
  })

  test("handles mention-prefixed /new", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await ChannelCommand.execute(
          "@Synergy /new",
          {
            ...baseContext,
            wasMentioned: true,
            mentions: [{ key: "@_user_1", name: "Synergy" }],
          },
          ScopeContext.current.scope,
        )
        expect(result).toEqual({
          action: "handled",
          reply: "✅ Started a new conversation. Send your next message when ready.",
        })
      },
    })
  })

  test("handles mention-prefixed /new with continuation text", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await ChannelCommand.execute(
          "@Synergy /new 帮我总结今天会议",
          {
            ...baseContext,
            wasMentioned: true,
            mentions: [{ key: "@_user_1", name: "Synergy" }],
          },
          ScopeContext.current.scope,
        )
        expect(result).toEqual({
          action: "continue",
          text: "帮我总结今天会议",
        })
      },
    })
  })

  test("ignores mention-prefixed text without a command", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await ChannelCommand.execute(
          "@Synergy 你好",
          {
            ...baseContext,
            wasMentioned: true,
            mentions: [{ key: "@_user_1", name: "Synergy" }],
          },
          ScopeContext.current.scope,
        )
        expect(result).toEqual({ action: "skip" })
      },
    })
  })

  test("selects workflows, preserves inline requests, and rejects conflicting switches", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect(
          await ChannelCommand.execute("/blueprint Design the release", baseContext, ScopeContext.current.scope),
        ).toEqual({
          action: "continue",
          text: "Design the release",
        })
        expect((await workflowSession()).workflow).toEqual({ kind: "plan" })
        expect((await workflowSession()).interaction).toEqual({ mode: "interactive", source: "channel:feishu" })

        expect(
          await ChannelCommand.execute("/lattice Ship the feature", baseContext, ScopeContext.current.scope),
        ).toEqual({
          action: "handled",
          reply:
            "⚠️ Cannot enable Lattice while the plan workflow is active. Use /chat first to exit the current workflow.",
        })

        expect(
          await ChannelCommand.execute("/chat Continue normally", baseContext, ScopeContext.current.scope),
        ).toEqual({
          action: "continue",
          text: "Continue normally",
        })
        expect((await workflowSession()).workflow).toBeUndefined()

        expect(
          await ChannelCommand.execute("/lightloop Fix the failing tests", baseContext, ScopeContext.current.scope),
        ).toEqual({
          action: "continue",
          text: "Fix the failing tests",
        })
        const session = await workflowSession()
        expect(session.workflow).toEqual({ kind: "lightloop", instructions: "Fix the failing tests" })

        const lease = SessionManager.acquire(session.id)
        expect(lease).toBeDefined()
        try {
          expect(await ChannelCommand.execute("/chat", baseContext, ScopeContext.current.scope)).toEqual({
            action: "handled",
            reply: "✅ Switched to normal chat.",
          })
          expect(lease?.signal.aborted).toBe(true)
        } finally {
          await SessionManager.release(lease!, { requestNextWork: false })
          SessionManager.unregisterRuntime(session.id)
        }
      },
    })
  })

  test("requires instructions before enabling Light Loop", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect(await ChannelCommand.execute("/lightloop", baseContext, ScopeContext.current.scope)).toEqual({
          action: "handled",
          reply: "Usage: /lightloop <task>",
        })
      },
    })
  })

  test("/help lists available commands", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await ChannelCommand.execute("/help", baseContext, ScopeContext.current.scope)
        expect(result).toEqual({
          action: "handled",
          reply: [
            "Available commands:",
            "/chat [message] — use normal chat for this conversation",
            "/blueprint [request] (/plan) — use Plan to author a Blueprint",
            "/lightloop <task> — keep working until the task passes independent review",
            "/lattice [goal] — decompose and execute a larger goal",
            "/model <providerID/modelID> — change the model for this conversation",
            "/new — start a new conversation",
            "/status — show the current conversation status",
            "/help — show this command list",
          ].join("\n"),
        })
      },
    })
  })

  test("/status reports when no conversation exists yet", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await ChannelCommand.execute(
          "/status",
          { ...baseContext, chatId: "chat_status_empty" },
          ScopeContext.current.scope,
        )
        expect(result).toEqual({
          action: "handled",
          reply: "📭 No conversation history yet.",
        })
      },
    })
  })

  test("/new refuses to archive a session with an active generation", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({
            type: baseContext.channelType,
            accountId: baseContext.accountId,
            chatId: baseContext.chatId,
          }),
        })
        const lease = SessionManager.acquire(session.id)
        if (!lease) throw new Error("expected active session lease")

        try {
          expect(await ChannelCommand.execute("/new", baseContext, ScopeContext.current.scope)).toEqual({
            action: "handled",
            reply: "⚠️ Wait for the current response to finish before starting a new conversation.",
          })
          expect((await Session.get(session.id)).time.archived).toBeUndefined()
        } finally {
          await SessionManager.release(lease, { requestNextWork: false })
          SessionManager.unregisterRuntime(session.id)
        }
      },
    })
  })

  test("/new archives the existing channel session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({
            type: baseContext.channelType,
            accountId: baseContext.accountId,
            chatId: baseContext.chatId,
          }),
        })

        await ChannelCommand.execute("/new", baseContext, ScopeContext.current.scope)

        const archived = await Session.get(session.id)
        expect(archived?.time.archived).toBeTruthy()
      },
    })
  })
})
