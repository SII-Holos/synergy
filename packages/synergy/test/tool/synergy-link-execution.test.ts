import { afterEach, describe, expect, test } from "bun:test"
import type {
  SynergyLinkBash,
  SynergyLinkClient,
  SynergyLinkProcess,
  SynergyLinkSession,
} from "@ericsanchezok/synergy-link-protocol"
import { SynergyLinkExecution } from "../../src/tool/synergy-link-execution"

function fakeClient(): SynergyLinkClient.ExecutionClient {
  return {
    executeBash: async (): Promise<SynergyLinkBash.Result> => {
      throw new Error("unexpected bash execution")
    },
    executeProcess: async (): Promise<SynergyLinkProcess.Result> => {
      throw new Error("unexpected process execution")
    },
    executeSession: async (): Promise<SynergyLinkSession.Result> => {
      throw new Error("unexpected session execution")
    },
  }
}

afterEach(() => {
  SynergyLinkExecution.setClient(null)
})

describe("Synergy Link execution state", () => {
  test("keeps sessions for different target agents on the same link", () => {
    SynergyLinkExecution.upsertSession({
      linkID: "link_shared",
      targetID: "target_first",
      targetAgentID: "agent_first",
      sourceAgent: "build",
      sessionID: "session_first",
      status: "opened",
      openedAt: 1,
      lastUsedAt: 1,
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_shared",
      targetID: "target_second",
      targetAgentID: "agent_second",
      sourceAgent: "review",
      sessionID: "session_second",
      status: "opened",
      openedAt: 2,
      lastUsedAt: 2,
    })

    expect(
      SynergyLinkExecution.getSession("link_shared", {
        targetID: "target_first",
        targetAgentID: "agent_first",
        sourceAgent: "build",
      })?.sessionID,
    ).toBe("session_first")
    expect(
      SynergyLinkExecution.getSession("link_shared", {
        targetID: "target_second",
        targetAgentID: "agent_second",
        sourceAgent: "review",
      })?.sessionID,
    ).toBe("session_second")
    expect(SynergyLinkExecution.allSessions()).toHaveLength(2)
  })

  test("does not resolve a raw session owned by another local agent", async () => {
    SynergyLinkExecution.setClient(fakeClient())
    SynergyLinkExecution.upsertSession({
      linkID: "link_private",
      targetAgentID: "agent_remote",
      sourceAgent: "build",
      sessionID: "session_private",
      status: "opened",
      openedAt: 1,
      lastUsedAt: 1,
    })

    await expect(
      SynergyLinkExecution.resolveExecutionTarget({
        linkID: "link_private",
        linkIDSupplied: true,
        targetIDSupplied: false,
        tool: "bash",
        agent: "review",
      }),
    ).rejects.toBeInstanceOf(SynergyLinkExecution.NoSessionError)
  })

  test("disposes the previous client and clears sessions when transport changes", () => {
    let disposed = 0
    const previous = Object.assign(fakeClient(), {
      dispose() {
        disposed++
      },
    })
    SynergyLinkExecution.setClient(previous)
    SynergyLinkExecution.upsertSession({
      linkID: "link_reconnect",
      targetAgentID: "agent_remote",
      sourceAgent: "build",
      sessionID: "session_reconnect",
      status: "opened",
      openedAt: 1,
      lastUsedAt: 1,
    })

    SynergyLinkExecution.setClient(fakeClient())

    expect(disposed).toBe(1)
    expect(SynergyLinkExecution.allSessions()).toEqual([])
  })
})
