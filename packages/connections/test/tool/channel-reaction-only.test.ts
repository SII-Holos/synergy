import { afterAll as afterRuntimeTests, afterEach, describe, expect, mock, test } from "bun:test"
import { ChannelReactionOnlyTool } from "@ericsanchezok/synergy-connections/channel/tools/channel-reaction-only"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { SessionEndpoint } from "@ericsanchezok/synergy-harness/session/endpoint"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()

const originalConfigCurrent = Config.current

function context(sessionID: string): Tool.Context {
  return {
    sessionID,
    messageID: "msg_reaction_only",
    callID: "call_reaction_only",
    agent: "synergy",
    abort: new AbortController().signal,
    metadata() {},
    async ask() {
      throw new Error("channel_reaction_only must not ask for permission")
    },
  }
}

function configureFeishu(account: Record<string, unknown> | undefined, channelStreaming?: boolean) {
  Config.current = mock(async () => {
    return {
      channel: {
        feishu: {
          type: "feishu",
          ...(channelStreaming === undefined ? {} : { streaming: channelStreaming }),
          accounts: account === undefined ? {} : { account_test: account },
        },
      },
    }
  }) as unknown as typeof Config.current
}

async function feishuSession() {
  const session = await Session.create({
    endpoint: SessionEndpoint.fromChannel({ type: "feishu", accountId: "account_test", chatId: "chat_test" }),
  })
  return session.id
}

describe("channel_reaction_only tool", () => {
  afterEach(() => {
    Config.current = originalConfigCurrent
  })

  /** Scope-backed executions need the runtime's authoritative store. */
  function runtimeTest(name: string, fn: () => Promise<void>) {
    test(name, () => runtime.run(fn))
  }

  runtimeTest("records the configured default reaction as the terminal intent", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sessionID = await feishuSession()
        configureFeishu({ reactionOnlyReply: { enabled: true }, streaming: false })
        const tool = await ChannelReactionOnlyTool.init()
        const result = await tool.execute({}, context(sessionID))

        expect(result.metadata.intent).toEqual({ type: "reaction_only", reaction: "SILENT" })
        expect(result.title).toBe("Reaction only: SILENT")
        // The intent is recorded, not delivered: the Channel runtime owns
        // delivery, and the tool result must order the model to stop and wait.
        expect(result.output).toContain("ONLY delivery")
        expect(result.output).toContain("wait for the user's next message")
      },
    })
  })

  runtimeTest("forces the account forceReaction over the built-in fallback", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sessionID = await feishuSession()
        configureFeishu({ reactionOnlyReply: { enabled: true, forceReaction: "DONE" }, streaming: false })
        const tool = await ChannelReactionOnlyTool.init()
        const result = await tool.execute({}, context(sessionID))
        expect(result.metadata.intent).toEqual({ type: "reaction_only", reaction: "DONE" })
      },
    })
  })

  test("takes no reaction parameter — the configured reaction cannot be overridden", async () => {
    const tool = await ChannelReactionOnlyTool.init()
    expect(Object.keys(tool.parameters.shape)).toEqual([])
  })

  runtimeTest("refuses when the account did not enable reactionOnlyReply", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sessionID = await feishuSession()
        configureFeishu({ streaming: false })
        const tool = await ChannelReactionOnlyTool.init()
        await expect(tool.execute({}, context(sessionID))).rejects.toThrow(/does not allow reaction-only/)
      },
    })
  })

  runtimeTest("refuses while the account still streams", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sessionID = await feishuSession()
        configureFeishu({ reactionOnlyReply: { enabled: true }, streaming: true })
        const tool = await ChannelReactionOnlyTool.init()
        await expect(tool.execute({}, context(sessionID))).rejects.toThrow(/does not allow reaction-only/)
      },
    })
  })

  runtimeTest("refuses when the account is absent from config", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const sessionID = await feishuSession()
        configureFeishu(undefined)
        const tool = await ChannelReactionOnlyTool.init()
        await expect(tool.execute({}, context(sessionID))).rejects.toThrow(/is not configured/)
      },
    })
  })

  runtimeTest("refuses in a non-Feishu Channel session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({
            type: "github",
            accountId: "account_test",
            chatId: "owner/repo#1",
          }),
        })
        configureFeishu({ reactionOnlyReply: { enabled: true }, streaming: false })
        const tool = await ChannelReactionOnlyTool.init()
        await expect(tool.execute({}, context(session.id))).rejects.toThrow(/only available in Feishu/)
      },
    })
  })

  test("refuses without a session (non-channel invocation)", async () => {
    const tool = await ChannelReactionOnlyTool.init()
    await expect(tool.execute({}, context("ses_missing"))).rejects.toThrow(/only available in Feishu/)
  })
})

afterRuntimeTests(() => runtime.close())
