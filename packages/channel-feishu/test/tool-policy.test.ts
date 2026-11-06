import { afterEach, describe, expect, mock, test } from "bun:test"
import { Config } from "@ericsanchezok/synergy-harness/config/config"
import { reactionOnlyToolAvailability, reactionOnlyToolVisibility } from "../src/tool-policy"

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

describe("channel_reaction_only availability gate", () => {
  afterEach(() => {
    Config.current = originalConfigCurrent
  })

  test("exposes channel_reaction_only only to Feishu Channel sessions", () => {
    expect(reactionOnlyToolVisibility({ toolName: "channel_reaction_only", session: {} })).toMatchObject({
      code: "tool_unavailable",
      toolName: "channel_reaction_only",
      metadata: { requiredEndpoint: "feishu" },
    })
    // Another channel type must not see it either.
    expect(
      reactionOnlyToolVisibility({
        toolName: "channel_reaction_only",
        session: {
          endpoint: { kind: "channel", channel: { type: "github", accountId: "a1", chatId: "o/r#1" } },
        },
      }),
    ).toMatchObject({ code: "tool_unavailable", metadata: { requiredEndpoint: "feishu" } })
    expect(reactionOnlyToolVisibility({ toolName: "channel_reaction_only", session: feishuSession() })).toBeUndefined()
  })

  test("hides channel_reaction_only from boss-role sessions", () => {
    // Boss-role sessions deliver only through explicit channel_push calls; a
    // reaction-only terminal would swallow the turn on both delivery paths.
    const bossSession = { ...feishuSession(), workflow: { kind: "boss", role: "boss" } as const }
    expect(reactionOnlyToolVisibility({ toolName: "channel_reaction_only", session: bossSession })).toMatchObject({
      code: "tool_unavailable",
      metadata: { requiredEndpoint: "feishu" },
    })
    // A non-boss workflow role on the same endpoint keeps the tool visible.
    const workerSession = { ...feishuSession(), workflow: { kind: "boss", role: "worker" } as const }
    expect(reactionOnlyToolVisibility({ toolName: "channel_reaction_only", session: workerSession })).toBeUndefined()
  })

  test("stays synchronous so a Promise cannot hide every tool", () => {
    // SessionModePolicy.visibility is synchronous and its aggregator does not
    // await: a returned Promise is truthy and would mark every definition from
    // every contribution source unavailable. Keep this guard.
    const result = reactionOnlyToolVisibility({ toolName: "channel_reaction_only", session: feishuSession() })
    expect(result instanceof Promise).toBe(false)
  })

  test("hides the tool when the account does not enable reactionOnlyReply", async () => {
    configureFeishu({ account: { streaming: false } })
    const diagnostics = await reactionOnlyToolAvailability({ session: feishuSession() as never, agent: "synergy" })
    expect(diagnostics.get("channel_reaction_only")).toMatchObject({ code: "tool_unavailable" })
  })

  test("hides the tool while the account still streams", async () => {
    configureFeishu({ account: { reactionOnlyReply: { enabled: true }, streaming: true } })
    const diagnostics = await reactionOnlyToolAvailability({ session: feishuSession() as never, agent: "synergy" })
    expect(diagnostics.get("channel_reaction_only")).toMatchObject({ code: "tool_unavailable" })
  })

  test("hides the tool after the account is disabled", async () => {
    configureFeishu({ account: { enabled: false, reactionOnlyReply: { enabled: true }, streaming: false } })
    const diagnostics = await reactionOnlyToolAvailability({ session: feishuSession() as never, agent: "synergy" })
    expect(diagnostics.get("channel_reaction_only")).toMatchObject({ code: "tool_unavailable" })
  })

  test("exposes the tool when enabled with streaming disabled", async () => {
    configureFeishu({ account: { reactionOnlyReply: { enabled: true, forceReaction: "SILENT" }, streaming: false } })
    const diagnostics = await reactionOnlyToolAvailability({ session: feishuSession() as never, agent: "synergy" })
    expect(diagnostics.has("channel_reaction_only")).toBe(false)
  })

  test("inherits channel-level streaming:false when the account does not set it", async () => {
    configureFeishu({ account: { reactionOnlyReply: { enabled: true } }, channelStreaming: false })
    const diagnostics = await reactionOnlyToolAvailability({ session: feishuSession() as never, agent: "synergy" })
    expect(diagnostics.has("channel_reaction_only")).toBe(false)
  })

  test("hides the tool for a non-Feishu session without reading config", async () => {
    Config.current = mock(async () => {
      throw new Error("config must not be read for non-Feishu sessions")
    }) as unknown as typeof Config.current
    const diagnostics = await reactionOnlyToolAvailability({
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
    const diagnostics = await reactionOnlyToolAvailability({ session: feishuSession() as never, agent: "synergy" })
    expect(diagnostics.get("channel_reaction_only")).toMatchObject({ code: "tool_unavailable" })
  })
})
