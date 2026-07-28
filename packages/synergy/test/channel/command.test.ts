import { describe, expect, test } from "bun:test"
import { ChannelCommand } from "../../src/channel/command"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionManager } from "../../src/session/manager"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

describe("ChannelCommand", () => {
  const baseContext = {
    channelType: "feishu",
    accountId: "acct_test",
    chatId: "chat_test",
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
    )
    if (!session) throw new Error("expected channel session")
    return session
  }

  test("handles bare /new with explicit confirmation", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await ChannelCommand.execute("/new", baseContext)
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
        const result = await ChannelCommand.execute("@Synergy /new", {
          ...baseContext,
          wasMentioned: true,
          mentions: [{ key: "@_user_1", name: "Synergy" }],
        })
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
        const result = await ChannelCommand.execute("@Synergy /new 帮我总结今天会议", {
          ...baseContext,
          wasMentioned: true,
          mentions: [{ key: "@_user_1", name: "Synergy" }],
        })
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
        const result = await ChannelCommand.execute("@Synergy 你好", {
          ...baseContext,
          wasMentioned: true,
          mentions: [{ key: "@_user_1", name: "Synergy" }],
        })
        expect(result).toEqual({ action: "skip" })
      },
    })
  })

  test("selects channel workflows and keeps command text as the user request", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const blueprint = await ChannelCommand.execute("/blueprint Design the release", baseContext)
        expect(blueprint).toEqual({ action: "continue", text: "Design the release" })
        expect((await workflowSession()).workflow).toEqual({ kind: "plan" })

        const chat = await ChannelCommand.execute("/chat Continue normally", baseContext)
        expect(chat).toEqual({ action: "continue", text: "Continue normally" })
        expect((await workflowSession()).workflow).toBeUndefined()

        const lightloop = await ChannelCommand.execute("/lightloop Fix the failing tests", baseContext)
        expect(lightloop).toEqual({ action: "continue", text: "Fix the failing tests" })
        expect((await workflowSession()).workflow).toEqual({
          kind: "lightloop",
          instructions: "Fix the failing tests",
        })

        await ChannelCommand.execute("/chat", baseContext)
        const lattice = await ChannelCommand.execute("/lattice Ship the feature", baseContext)
        expect(lattice).toEqual({ action: "continue", text: "Ship the feature" })
        expect((await workflowSession()).workflow).toMatchObject({
          kind: "lattice",
          mode: "auto",
        })
      },
    })
  })

  test("handles mention-prefixed workflow commands", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await ChannelCommand.execute("@Synergy /lightloop 完成并验证修复", {
          ...baseContext,
          wasMentioned: true,
          mentions: [{ key: "@_user_1", name: "Synergy" }],
        })
        expect(result).toEqual({ action: "continue", text: "完成并验证修复" })
        expect((await workflowSession()).workflow).toEqual({
          kind: "lightloop",
          instructions: "完成并验证修复",
        })
      },
    })
  })

  test("preserves channel metadata when a workflow command creates the session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await ChannelCommand.execute("/blueprint", baseContext)
        expect((await workflowSession()).endpoint).toMatchObject({
          kind: "channel",
          channel: {
            type: "feishu",
            accountId: "acct_test",
            chatId: "chat_test",
            chatType: "group",
            chatName: "Synergy Dev",
            senderId: "user_test",
            senderName: "Maintainer",
            createdAt: expect.any(Number),
          },
        })
      },
    })
  })

  test("uses Light Loop cancellation when switching to normal chat", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await ChannelCommand.execute("/lightloop Finish the task", baseContext)
        const session = await workflowSession()
        const lease = SessionManager.acquire(session.id)
        expect(lease).toBeDefined()

        try {
          expect(await ChannelCommand.execute("/chat", baseContext)).toEqual({
            action: "handled",
            reply: "✅ Switched to normal chat.",
          })
          expect(lease?.signal.aborted).toBe(true)
          expect((await Session.get(session.id)).workflow).toBeUndefined()
        } finally {
          await SessionManager.release(lease!, { requestNextWork: false })
          SessionManager.unregisterRuntime(session.id)
        }
      },
    })
  })

  test("updates the active Light Loop task but does not replace a different workflow", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await ChannelCommand.execute("/lightloop Original task", baseContext)
        expect(await ChannelCommand.execute("/lightloop Revised task", baseContext)).toEqual({
          action: "continue",
          text: "Revised task",
        })
        expect((await workflowSession()).workflow).toEqual({
          kind: "lightloop",
          instructions: "Revised task",
        })

        await ChannelCommand.execute("/chat", baseContext)
        await ChannelCommand.execute("/blueprint", baseContext)
        expect(await ChannelCommand.execute("/lattice New goal", baseContext)).toEqual({
          action: "handled",
          reply:
            "⚠️ Cannot enable Lattice while the plan workflow is active. Use /chat first to exit the current workflow.",
        })
        expect((await workflowSession()).workflow).toEqual({ kind: "plan" })
      },
    })
  })

  test("rejects workflow changes while the session is busy", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await ChannelCommand.execute("/chat", baseContext)
        const session = await workflowSession()
        const lease = SessionManager.acquire(session.id)
        expect(lease).toBeDefined()

        try {
          expect(await ChannelCommand.execute("/blueprint Design the release", baseContext)).toEqual({
            action: "handled",
            reply: "⚠️ Wait for the current response to finish before switching workflows.",
          })
          expect((await Session.get(session.id)).workflow).toBeUndefined()
        } finally {
          await SessionManager.release(lease!, { requestNextWork: false })
          SessionManager.unregisterRuntime(session.id)
        }
      },
    })
  })

  test("requires a task when enabling Light Loop", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect(await ChannelCommand.execute("/lightloop", baseContext)).toEqual({
          action: "handled",
          reply: "Usage: /lightloop <task>",
        })
      },
    })
  })

  test("allows selecting a workflow before sending its first request", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        expect(await ChannelCommand.execute("/blueprint", baseContext)).toEqual({
          action: "handled",
          reply: "✅ Blueprint planning enabled. Send the request you want turned into a Blueprint.",
        })
        expect((await workflowSession()).workflow).toEqual({ kind: "plan" })

        expect(await ChannelCommand.execute("/chat", baseContext)).toEqual({
          action: "handled",
          reply: "✅ Switched to normal chat.",
        })
        expect((await workflowSession()).workflow).toBeUndefined()

        expect(await ChannelCommand.execute("/lattice", baseContext)).toEqual({
          action: "handled",
          reply: "✅ Lattice enabled. Send the goal you want decomposed and executed.",
        })
        expect((await workflowSession()).workflow).toMatchObject({ kind: "lattice", mode: "auto" })
      },
    })
  })

  test("/help lists available commands", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await ChannelCommand.execute("/help", baseContext)
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
        const result = await ChannelCommand.execute("/status", baseContext)
        expect(result).toEqual({
          action: "handled",
          reply: "📭 No conversation history yet.",
        })
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

        await ChannelCommand.execute("/new", baseContext)

        const archived = await Session.get(session.id)
        expect(archived?.time.archived).toBeTruthy()
      },
    })
  })
})
