import { describe, expect, test } from "bun:test"
import { ConnectTool } from "../../src/tool/connect"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.connect", () => {
  test("rejects local aliases with a semantic error", async () => {
    const tool = await ConnectTool.init()
    await expect(tool.execute({ action: "status", envID: ":local" }, ctx)).rejects.toThrow(
      'connect cannot use envID ":local" because it resolves to the local machine.',
    )
  })

  test("rejects missing envID with local guidance", async () => {
    const tool = await ConnectTool.init()
    await expect(tool.execute({ action: "open", targetAgentID: "agent_test" }, ctx)).rejects.toThrow(
      "connect requires a real remote envID",
    )
  })

  test("rejects missing targetAgentID with semantic guidance", async () => {
    const tool = await ConnectTool.init()
    await expect(tool.execute({ action: "open", envID: "env_test" }, ctx)).rejects.toThrow(
      "connect open requires targetAgentID",
    )
  })
})
