import { describe, expect, test } from "bun:test"
import type {
  SynergyLinkClient,
  SynergyLinkBash,
  SynergyLinkProcess,
  SynergyLinkSession,
} from "@ericsanchezok/synergy-link-protocol"
import { ConnectTool } from "../../src/tool/connect"
import { SynergyLinkExecution } from "../../src/tool/synergy-link-execution"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

const fakeClient = (result: SynergyLinkSession.Result): SynergyLinkClient.ExecutionClient => ({
  executeBash: async (): Promise<SynergyLinkBash.Result> => {
    throw new Error("unexpected bash execution")
  },
  executeProcess: async (): Promise<SynergyLinkProcess.Result> => {
    throw new Error("unexpected process execution")
  },
  executeSession: async (): Promise<SynergyLinkSession.Result> => result,
})

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

  test("does not record a local session when open returns busy", async () => {
    SynergyLinkExecution.setClient(
      fakeClient({
        title: "Session busy",
        metadata: {
          action: "open",
          status: "busy",
          sessionID: "session_existing",
          backend: "remote",
        },
        output: "Host is busy with session session_existing.",
      }),
    )
    try {
      const tool = await ConnectTool.init()
      const result = await tool.execute({ action: "open", linkID: "link_test", targetAgentID: "agent_test" }, ctx)

      expect(result.metadata.status).toBe("busy")
      expect(SynergyLinkExecution.getSession("link_test")).toBeUndefined()
    } finally {
      SynergyLinkExecution.setClient(null)
    }
  })
})
