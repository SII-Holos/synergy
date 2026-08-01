import { SynergyLinkRemoteError } from "../../src/remote/client"
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

  test("matches a registered target to a bootstrap session with the same transport agent", () => {
    SynergyLinkExecution.upsertSession({
      linkID: "link_bootstrap",
      targetAgentID: "agent_bootstrap",
      sourceAgent: "build",
      sessionID: "session_bootstrap",
      status: "opened",
      openedAt: 1,
      lastUsedAt: 1,
    })

    expect(
      SynergyLinkExecution.getSession("link_bootstrap", {
        targetID: "target_registered_later",
        targetAgentID: "agent_bootstrap",
      })?.sessionID,
    ).toBe("session_bootstrap")
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

describe("Synergy Link verified session cache", () => {
  test("heartbeat-verifies a cached session before remote execution", async () => {
    const actions: Array<{ action: string; sessionID?: string }> = []
    SynergyLinkExecution.setClient({
      ...fakeClient(),
      executeSession: async (_linkID, payload): Promise<SynergyLinkSession.Result> => {
        actions.push({
          action: payload.action,
          sessionID: "sessionID" in payload ? payload.sessionID : undefined,
        })
        return {
          title: "Session alive",
          metadata: { action: payload.action, status: "alive", sessionID: "session_verify", backend: "remote" },
          output: "alive",
        }
      },
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_verify",
      targetAgentID: "agent_verify",
      sourceAgent: "build",
      sessionID: "session_verify",
      status: "opened",
      openedAt: 1,
      lastUsedAt: 1,
    })

    const target = await SynergyLinkExecution.resolveExecutionTarget({
      linkID: "link_verify",
      linkIDSupplied: true,
      targetIDSupplied: false,
      tool: "bash",
      agent: "build",
    })

    expect(target.kind).toBe("remote")
    expect(actions).toEqual([{ action: "heartbeat", sessionID: "session_verify" }])
    const session = SynergyLinkExecution.getSession("link_verify")
    expect(session?.lastAttemptAt).toBeGreaterThan(0)
    expect(session?.lastVerifiedAt).toBeGreaterThan(0)
  })

  test("clears a session the host reports as invalid before remote execution", async () => {
    let sessionCalls = 0
    SynergyLinkExecution.setClient({
      ...fakeClient(),
      executeSession: async (): Promise<SynergyLinkSession.Result> => {
        sessionCalls++
        throw new SynergyLinkRemoteError("session_invalid", "Session is not active.")
      },
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_invalid",
      targetAgentID: "agent_invalid",
      sourceAgent: "build",
      sessionID: "session_invalid",
      status: "opened",
      openedAt: 1,
      lastUsedAt: 1,
    })

    await expect(
      SynergyLinkExecution.resolveExecutionTarget({
        linkID: "link_invalid",
        linkIDSupplied: true,
        targetIDSupplied: false,
        tool: "bash",
        agent: "build",
      }),
    ).rejects.toBeInstanceOf(SynergyLinkExecution.NoSessionError)
    expect(sessionCalls).toBe(1)
    expect(SynergyLinkExecution.getSession("link_invalid")).toBeUndefined()
  })

  test("reports unverified on verification timeout without refreshing lastVerifiedAt", async () => {
    const lastVerifiedAt = 1_000
    SynergyLinkExecution.setClient({
      ...fakeClient(),
      executeSession: async (): Promise<SynergyLinkSession.Result> => {
        throw new SynergyLinkRemoteError("transport_error", "Timed out waiting for Synergy Link response.")
      },
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_timeout",
      targetAgentID: "agent_timeout",
      sourceAgent: "build",
      sessionID: "session_timeout",
      status: "opened",
      openedAt: 1,
      lastUsedAt: 1,
      lastVerifiedAt,
    })

    await expect(
      SynergyLinkExecution.resolveExecutionTarget({
        linkID: "link_timeout",
        linkIDSupplied: true,
        targetIDSupplied: false,
        tool: "bash",
        agent: "build",
      }),
    ).rejects.toBeInstanceOf(SynergyLinkExecution.UnverifiedSessionError)
    const session = SynergyLinkExecution.getSession("link_timeout")
    expect(session?.lastVerifiedAt).toBe(lastVerifiedAt)
    expect(session?.lastAttemptAt).toBeGreaterThan(lastVerifiedAt)
  })

  test("verifySession reports missing without a cached session", async () => {
    SynergyLinkExecution.setClient(fakeClient())
    const verification = await SynergyLinkExecution.verifySession("link_none", {
      targetAgentID: "agent_none",
    })
    expect(verification.kind).toBe("missing")
  })
})
