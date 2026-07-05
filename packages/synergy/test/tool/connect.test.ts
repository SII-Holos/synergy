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
    await expect(tool.execute({ action: "status", linkID: ":local" }, ctx)).rejects.toThrow("Invalid linkID")
  })

  test("rejects missing linkID for lifecycle actions", async () => {
    const tool = await ConnectTool.init()
    await expect(tool.execute({ action: "open", targetAgentID: "agent_test" }, ctx)).rejects.toThrow("Missing linkID")
  })

  test("rejects missing targetAgentID with semantic guidance", async () => {
    const tool = await ConnectTool.init()
    await expect(tool.execute({ action: "open", linkID: "link_test" }, ctx)).rejects.toThrow(
      "connect open requires targetAgentID",
    )
  })
})
