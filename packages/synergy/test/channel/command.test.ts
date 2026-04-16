import { describe, expect, test } from "bun:test"
import { ChannelCommand } from "../../src/channel/command"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { Instance } from "../../src/scope/instance"
import { tmpdir } from "../fixture/fixture"

describe("ChannelCommand", () => {
  const baseContext = {
    channelType: "feishu",
    accountId: "acct_test",
    chatId: "chat_test",
    senderId: "user_test",
    messageId: "msg_test",
  }

  test("handles bare /new with explicit confirmation", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
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
    await Instance.provide({
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
    await Instance.provide({
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
    await Instance.provide({
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

  test("/help lists available commands", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const result = await ChannelCommand.execute("/help", baseContext)
        expect(result).toEqual({
          action: "handled",
          reply: [
            "Available commands:",
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
    await Instance.provide({
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
    await Instance.provide({
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
