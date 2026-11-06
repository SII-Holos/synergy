import { describe, expect, test } from "bun:test"
import { channelToolVisibility } from "../../src/channel/tool-policy"
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
})
