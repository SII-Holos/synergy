import { afterEach, describe, expect, mock, test } from "bun:test"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { channelToolAvailability, channelToolVisibility } from "../../src/channel/tool-policy"

const originalConfigCurrent = Config.current

function feishuSession(accountId = "account_test") {
  return {
    endpoint: {
      kind: "channel" as const,
      channel: { type: "feishu", accountId, chatId: "chat_test" },
    },
  }
}

function configureFeishu(input: { account?: Record<string, unknown>; channelStreaming?: boolean }) {
  Config.current = mock(async () => {
    return {
      channel: {
        feishu: {
          type: "feishu",
          ...(input.channelStreaming === undefined ? {} : { streaming: input.channelStreaming }),
          accounts: input.account ? { account_test: input.account } : {},
        },
      },
    }
  }) as unknown as typeof Config.current
}

describe("SessionModePolicy Channel visibility", () => {
  test("exposes response_card only to Channel sessions", () => {
    const diagnostic = channelToolVisibility({ toolName: "response_card", session: {} })
    expect(diagnostic).toMatchObject({
      code: "tool_unavailable",
      toolName: "response_card",
      metadata: { requiredEndpoint: "channel" },
    })
    expect(diagnostic?.message).toContain("only available in Channel sessions")

    expect(
      channelToolVisibility({
        toolName: "response_card",
        session: {
          endpoint: {
            kind: "channel",
            channel: { type: "feishu", accountId: "account_test", chatId: "chat_test" },
          },
        },
      }),
    ).toBeUndefined()
    expect(channelToolVisibility({ toolName: "read", session: {} })).toBeUndefined()
  })

  test("exposes github_deliver_fix only to GitHub Channel sessions", () => {
    const diagnostic = channelToolVisibility({ toolName: "github_deliver_fix", session: {} })
    expect(diagnostic).toMatchObject({
      code: "tool_unavailable",
      toolName: "github_deliver_fix",
      metadata: { requiredEndpoint: "github" },
    })
    expect(diagnostic?.message).toContain("only available in GitHub Channel sessions")

    // A non-GitHub channel session (e.g. Feishu) must not see the tool.
    expect(
      channelToolVisibility({
        toolName: "github_deliver_fix",
        session: {
          endpoint: {
            kind: "channel",
            channel: { type: "feishu", accountId: "account_test", chatId: "chat_test" },
          },
        },
      }),
    ).toMatchObject({
      code: "tool_unavailable",
      toolName: "github_deliver_fix",
      metadata: { requiredEndpoint: "github" },
    })

    expect(
      channelToolVisibility({
        toolName: "github_deliver_fix",
        session: {
          endpoint: {
            kind: "channel",
            channel: { type: "github", accountId: "account_test", chatId: "owner/repo#1" },
          },
        },
      }),
    ).toBeUndefined()
  })
})

describe("channel_reaction_only availability gate", () => {
  afterEach(() => {
    Config.current = originalConfigCurrent
  })

  test("exposes channel_reaction_only only to Feishu Channel sessions", () => {
    expect(channelToolVisibility({ toolName: "channel_reaction_only", session: {} })).toMatchObject({
      code: "tool_unavailable",
      toolName: "channel_reaction_only",
      metadata: { requiredEndpoint: "feishu" },
    })
    // Another channel type must not see it either.
    expect(
      channelToolVisibility({
        toolName: "channel_reaction_only",
        session: {
          endpoint: { kind: "channel", channel: { type: "github", accountId: "a1", chatId: "o/r#1" } },
        },
      }),
    ).toMatchObject({ code: "tool_unavailable", metadata: { requiredEndpoint: "feishu" } })
    expect(channelToolVisibility({ toolName: "channel_reaction_only", session: feishuSession() })).toBeUndefined()
  })

  test("stays synchronous so a Promise cannot hide every tool", () => {
    // SessionModePolicy.visibility is synchronous and its aggregator does not
    // await: a returned Promise is truthy and would mark every definition from
    // every contribution source unavailable. Keep this guard.
    const result = channelToolVisibility({ toolName: "channel_reaction_only", session: feishuSession() })
    expect(result instanceof Promise).toBe(false)
  })

  test("hides the tool when the account does not enable reactionOnlyReply", async () => {
    configureFeishu({ account: { streaming: false } })
    const diagnostics = await channelToolAvailability({ session: feishuSession() as never, agent: "synergy" })
    expect(diagnostics.get("channel_reaction_only")).toMatchObject({ code: "tool_unavailable" })
  })

  test("hides the tool while the account still streams", async () => {
    configureFeishu({ account: { reactionOnlyReply: { enabled: true }, streaming: true } })
    const diagnostics = await channelToolAvailability({ session: feishuSession() as never, agent: "synergy" })
    expect(diagnostics.get("channel_reaction_only")).toMatchObject({ code: "tool_unavailable" })
  })

  test("exposes the tool when enabled with streaming disabled", async () => {
    configureFeishu({ account: { reactionOnlyReply: { enabled: true, forceReaction: "SILENT" }, streaming: false } })
    const diagnostics = await channelToolAvailability({ session: feishuSession() as never, agent: "synergy" })
    expect(diagnostics.has("channel_reaction_only")).toBe(false)
  })

  test("inherits channel-level streaming:false when the account does not set it", async () => {
    configureFeishu({ account: { reactionOnlyReply: { enabled: true } }, channelStreaming: false })
    const diagnostics = await channelToolAvailability({ session: feishuSession() as never, agent: "synergy" })
    expect(diagnostics.has("channel_reaction_only")).toBe(false)
  })

  test("hides the tool for a non-Feishu session without reading config", async () => {
    Config.current = mock(async () => {
      throw new Error("config must not be read for non-Feishu sessions")
    }) as unknown as typeof Config.current
    const diagnostics = await channelToolAvailability({
      session: {
        endpoint: { kind: "channel", channel: { type: "github", accountId: "a1", chatId: "o/r#1" } },
      } as never,
      agent: "synergy",
    })
    expect(diagnostics.size).toBe(0)
  })

  test("fails closed when reading config throws", async () => {
    Config.current = mock(async () => {
      throw new Error("config unavailable")
    }) as unknown as typeof Config.current
    const diagnostics = await channelToolAvailability({ session: feishuSession() as never, agent: "synergy" })
    expect(diagnostics.get("channel_reaction_only")).toMatchObject({ code: "tool_unavailable" })
  })

  test("fails closed for an account missing from config", async () => {
    configureFeishu({ account: undefined })
    const diagnostics = await channelToolAvailability({ session: feishuSession() as never, agent: "synergy" })
    expect(diagnostics.get("channel_reaction_only")).toMatchObject({ code: "tool_unavailable" })
  })
})
