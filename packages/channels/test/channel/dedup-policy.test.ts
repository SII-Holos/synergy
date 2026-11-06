import { expect, test } from "bun:test"
import { channelToolVisibility } from "../../src/channel/tool-policy"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

test("channel tool policy rejects unsupported endpoint capabilities and preserves unrelated tools", () =>
  runtime.run(() => {
    expect(channelToolVisibility({ toolName: "response_card" })).toMatchObject({
      code: "tool_unavailable",
      metadata: { requiredEndpoint: "channel" },
    })
    const channel = {
      endpoint: { kind: "channel" as const, channel: { type: "feishu", accountId: "a", scopeKey: "b" } },
    }
    expect(channelToolVisibility({ toolName: "response_card", session: channel })).toBeUndefined()
    expect(channelToolVisibility({ toolName: "read_file" })).toBeUndefined()
  }))

afterRuntimeTests(() => runtime.close())
