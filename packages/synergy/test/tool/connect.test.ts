import { SynergyLinkRemoteError } from "../../src/remote/client"
import { beforeEach, describe, expect, test } from "bun:test"
import type {
  SynergyLinkClient,
  SynergyLinkBash,
  SynergyLinkProcess,
  SynergyLinkSession,
} from "@ericsanchezok/synergy-link-protocol"
import { ConnectTool } from "../../src/synergy-link/tools/connect"
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
  // Client registry is module-global across files in the same test worker;
  // restore the no-client baseline so availability assertions are stable.
  beforeEach(() => {
    SynergyLinkExecution.setClient(null)
  })

  test("lists persisted targets available to the current agent", async () => {
    const { SynergyLinkTargetStore } = await import("../../src/synergy-link/target-store")
    const target = await SynergyLinkTargetStore.create({
      name: "Build Mac",
      targetAgentID: "agent_build_mac",
      linkID: "link_build_mac",
    })
    try {
      const tool = await ConnectTool.init()
      const result = await tool.execute({ action: "list_targets" }, ctx)
      expect(result.metadata.targets).toContainEqual(
        expect.objectContaining({ id: target.id, name: "Build Mac", availability: "unknown" }),
      )
      expect(result.output).toContain(target.id)
      expect(result.output).not.toContain("agent_build_mac")
      expect(result.output).not.toContain("link_build_mac")
    } finally {
      await SynergyLinkTargetStore.remove(target.id)
    }
  })

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

  test("does not clear another agent session when open returns busy", async () => {
    SynergyLinkExecution.setClient(
      fakeClient({
        title: "Session busy",
        metadata: {
          action: "open",
          status: "busy",
          sessionID: "session_other",
          backend: "remote",
        },
        output: "Host is busy with session session_other.",
      }),
    )
    SynergyLinkExecution.upsertSession({
      linkID: "link_test",
      targetAgentID: "agent_other",
      sourceAgent: "review",
      sessionID: "session_other",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })
    try {
      const tool = await ConnectTool.init()
      const result = await tool.execute({ action: "open", linkID: "link_test", targetAgentID: "agent_test" }, ctx)

      expect(result.metadata.status).toBe("busy")
      expect(SynergyLinkExecution.getSession("link_test", { targetAgentID: "agent_other" })?.sessionID).toBe(
        "session_other",
      )
    } finally {
      SynergyLinkExecution.setClient(null)
    }
  })

  test("opens a persisted target by stable targetID and records the observed host", async () => {
    const { SynergyLinkTargetStore } = await import("../../src/synergy-link/target-store")
    const target = await SynergyLinkTargetStore.create({
      name: "Remote Builder",
      targetAgentID: "agent_remote_builder",
      linkID: "link_remote_builder",
      allowedAgents: ["build"],
    })
    SynergyLinkExecution.setClient(
      fakeClient({
        title: "Session opened",
        metadata: {
          action: "open",
          status: "opened",
          sessionID: "session_remote_builder",
          backend: "remote",
          host: {
            type: "synergy_link.host.hello",
            linkID: "link_remote_builder",
            hostSessionID: "host_remote_builder",
            capabilities: {
              platform: "darwin",
              arch: "arm64",
              runtime: "bun",
              defaultShell: "sh",
              supportedShells: ["sh"],
              supportsPty: false,
              supportsSendKeys: true,
              supportsSoftKill: true,
              supportsProcessGroups: true,
              supportsBashDetach: true,
              envCaseInsensitive: false,
              lineEndings: "lf",
            },
          },
        },
        output: "Opened.",
      }),
    )
    try {
      const tool = await ConnectTool.init()
      const result = await tool.execute({ action: "open", targetID: target.id }, ctx)

      expect(result.metadata).toEqual(
        expect.objectContaining({ targetID: target.id, status: "opened", sessionID: "session_remote_builder" }),
      )
      expect(SynergyLinkExecution.getSession("link_remote_builder")?.targetID).toBe(target.id)
      expect(SynergyLinkExecution.getSession("link_remote_builder")?.supportsBashDetach).toBe(true)
      expect((await SynergyLinkTargetStore.require(target.id)).host?.capabilities.platform).toBe("darwin")
    } finally {
      SynergyLinkExecution.setClient(null)
      SynergyLinkExecution.clearSession("link_remote_builder")
      await SynergyLinkTargetStore.remove(target.id)
    }
  })

  test("does not let an agent bypass a target allowlist with a known targetID", async () => {
    const { SynergyLinkTargetStore } = await import("../../src/synergy-link/target-store")
    const target = await SynergyLinkTargetStore.create({
      name: "Review Host",
      targetAgentID: "agent_review_host",
      linkID: "link_review_host",
      allowedAgents: ["review"],
    })
    try {
      const tool = await ConnectTool.init()
      await expect(tool.execute({ action: "status", targetID: target.id }, ctx)).rejects.toThrow(
        "is not available to agent build",
      )
    } finally {
      await SynergyLinkTargetStore.remove(target.id)
    }
  })

  test("does not let an agent bypass a target allowlist with legacy locators", async () => {
    const { SynergyLinkTargetStore } = await import("../../src/synergy-link/target-store")
    const target = await SynergyLinkTargetStore.create({
      name: "Private Host",
      targetAgentID: "agent_private_host",
      linkID: "link_private_host",
      allowedAgents: ["review"],
    })
    try {
      const tool = await ConnectTool.init()
      await expect(
        tool.execute({ action: "open", linkID: target.linkID, targetAgentID: target.targetAgentID }, ctx),
      ).rejects.toThrow("is not available to agent build")
    } finally {
      await SynergyLinkTargetStore.remove(target.id)
    }
  })

  test("does not list active sessions for targets hidden from the current agent", async () => {
    const { SynergyLinkTargetStore } = await import("../../src/synergy-link/target-store")
    const target = await SynergyLinkTargetStore.create({
      name: "Private Session Host",
      targetAgentID: "agent_private_session_host",
      linkID: "link_private_session_host",
      allowedAgents: ["review"],
    })
    SynergyLinkExecution.upsertSession({
      linkID: target.linkID,
      targetID: target.id,
      targetAgentID: target.targetAgentID,
      sourceAgent: "review",
      sessionID: "session_private_session_host",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })
    try {
      const tool = await ConnectTool.init()
      const result = await tool.execute({ action: "list" }, ctx)

      expect(result.metadata.sessions).toEqual([])
      expect(result.output).toBe("No active Synergy Link sessions.")
    } finally {
      SynergyLinkExecution.clearSession(target.linkID)
      await SynergyLinkTargetStore.remove(target.id)
    }
  })

  test("lists raw sessions only for their source agent and marks them unregistered", async () => {
    SynergyLinkExecution.upsertSession({
      linkID: "link_unregistered",
      targetAgentID: "agent_unregistered",
      sourceAgent: "build",
      sessionID: "session_unregistered",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_foreign",
      targetAgentID: "agent_foreign",
      sourceAgent: "review",
      sessionID: "session_foreign",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })
    try {
      const tool = await ConnectTool.init()
      const result = await tool.execute({ action: "list" }, ctx)

      const sessions = result.metadata.sessions ?? []
      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toEqual(
        expect.objectContaining({
          linkID: "link_unregistered",
          sessionID: "session_unregistered",
          registered: false,
        }),
      )
      expect(result.output).toContain("unregistered")
      expect(result.output).not.toContain("link_foreign")
    } finally {
      SynergyLinkExecution.clearSession("link_unregistered")
      SynergyLinkExecution.clearSession("link_foreign")
    }
  })

  test("does not expose a different target session through targetID status", async () => {
    const { SynergyLinkTargetStore } = await import("../../src/synergy-link/target-store")
    const target = await SynergyLinkTargetStore.create({
      name: "Requested target",
      targetAgentID: "agent_requested",
      linkID: "link_shared_status",
      allowedAgents: ["build"],
    })
    SynergyLinkExecution.upsertSession({
      linkID: target.linkID,
      targetID: "target_other",
      targetAgentID: "agent_other",
      sourceAgent: "review",
      sessionID: "session_other",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })
    try {
      const tool = await ConnectTool.init()
      const result = await tool.execute({ action: "status", targetID: target.id }, ctx)

      expect(result.metadata).toEqual(
        expect.objectContaining({ targetID: target.id, status: "missing", sessionID: undefined }),
      )
      expect(result.output).toContain("No active connection")
    } finally {
      SynergyLinkExecution.clearSession(target.linkID)
      await SynergyLinkTargetStore.remove(target.id)
    }
  })

  test("closes an active session after its target is disabled", async () => {
    const { SynergyLinkTargetStore } = await import("../../src/synergy-link/target-store")
    const target = await SynergyLinkTargetStore.create({
      name: "Disabled target",
      targetAgentID: "agent_disabled",
      linkID: "link_disabled",
      allowedAgents: ["build"],
    })
    SynergyLinkExecution.setClient(
      fakeClient({
        title: "Session closed",
        metadata: { action: "close", status: "closed", sessionID: "session_disabled", backend: "remote" },
        output: "Closed.",
      }),
    )
    SynergyLinkExecution.upsertSession({
      linkID: target.linkID,
      targetID: target.id,
      targetAgentID: target.targetAgentID,
      sourceAgent: "build",
      sessionID: "session_disabled",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })
    await SynergyLinkTargetStore.update(target.id, { kind: "metadata", enabled: false })
    try {
      const tool = await ConnectTool.init()
      const result = await tool.execute({ action: "close", targetID: target.id }, ctx)

      expect(result.metadata.status).toBe("closed")
      expect(SynergyLinkExecution.getSession(target.linkID)).toBeUndefined()
    } finally {
      SynergyLinkExecution.setClient(null)
      await SynergyLinkTargetStore.remove(target.id)
    }
  })
  test("invalidates an active session when its persisted target is removed", async () => {
    const { SynergyLinkTargetService } = await import("../../src/synergy-link/target-service")
    const { SynergyLinkTargetStore } = await import("../../src/synergy-link/target-store")
    const target = await SynergyLinkTargetStore.create({
      name: "Removed private target",
      targetAgentID: "agent_removed_private",
      linkID: "link_removed_private",
      allowedAgents: ["review"],
    })
    SynergyLinkExecution.upsertSession({
      linkID: target.linkID,
      targetID: target.id,
      targetAgentID: target.targetAgentID,
      sourceAgent: "review",
      sessionID: "session_removed_private",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })

    await SynergyLinkTargetService.remove(target.id)

    expect(SynergyLinkExecution.getSession(target.linkID)).toBeUndefined()
    const tool = await ConnectTool.init()
    const listed = await tool.execute({ action: "list" }, ctx)
    expect(listed.metadata.sessions).toEqual([])
  })

  test("reuses an active session for the same local agent without reopening remotely", async () => {
    let sessionCalls = 0
    const openedAt = Date.now() - 1_000
    SynergyLinkExecution.setClient({
      ...fakeClient({
        title: "Session busy",
        metadata: { action: "open", status: "busy", backend: "remote" },
        output: "busy",
      }),
      executeSession: async (): Promise<SynergyLinkSession.Result> => {
        sessionCalls++
        throw new Error("unexpected session execution")
      },
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_reused",
      targetAgentID: "agent_reused",
      sourceAgent: "build",
      sessionID: "session_reused",
      status: "opened",
      openedAt,
      lastUsedAt: openedAt,
      lastVerifiedAt: openedAt,
    })
    try {
      const tool = await ConnectTool.init()
      const result = await tool.execute({ action: "open", linkID: "link_reused", targetAgentID: "agent_reused" }, ctx)

      expect(sessionCalls).toBe(0)
      expect(result.metadata).toEqual(expect.objectContaining({ status: "opened", sessionID: "session_reused" }))
      expect(SynergyLinkExecution.getSession("link_reused")?.openedAt).toBe(openedAt)
    } finally {
      SynergyLinkExecution.setClient(null)
    }
  })

  test("preserves an active session when remote close fails", async () => {
    SynergyLinkExecution.setClient({
      ...fakeClient({
        title: "unused",
        metadata: { action: "close", status: "closed", backend: "remote" },
        output: "unused",
      }),
      executeSession: async (): Promise<SynergyLinkSession.Result> => {
        throw new Error("transport offline")
      },
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_close_retry",
      targetAgentID: "agent_close_retry",
      sourceAgent: "build",
      sessionID: "session_close_retry",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })
    try {
      const tool = await ConnectTool.init()
      await expect(
        tool.execute({ action: "close", linkID: "link_close_retry", targetAgentID: "agent_close_retry" }, ctx),
      ).rejects.toThrow("transport offline")
      expect(
        SynergyLinkExecution.getSession("link_close_retry", {
          targetAgentID: "agent_close_retry",
          sourceAgent: "build",
        })?.sessionID,
      ).toBe("session_close_retry")
    } finally {
      SynergyLinkExecution.setClient(null)
    }
  })

  test("does not let another local agent close a raw session", async () => {
    let sessionCalls = 0
    SynergyLinkExecution.setClient({
      ...fakeClient({
        title: "unused",
        metadata: { action: "close", status: "closed", backend: "remote" },
        output: "unused",
      }),
      executeSession: async (): Promise<SynergyLinkSession.Result> => {
        sessionCalls++
        throw new Error("unexpected session execution")
      },
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_owned",
      targetAgentID: "agent_owned",
      sourceAgent: "build",
      sessionID: "session_owned",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })
    try {
      const tool = await ConnectTool.init()
      await expect(
        tool.execute(
          { action: "close", linkID: "link_owned", targetAgentID: "agent_owned" },
          { ...ctx, agent: "review" },
        ),
      ).rejects.toThrow("No active Synergy Link session")
      expect(sessionCalls).toBe(0)
      expect(SynergyLinkExecution.getSession("link_owned")?.sessionID).toBe("session_owned")
    } finally {
      SynergyLinkExecution.setClient(null)
    }
  })
})

describe("tool.connect verification", () => {
  test("status heartbeats a stale cached session before reporting it open", async () => {
    const actions: SynergyLinkSession.Action[] = []
    SynergyLinkExecution.setClient({
      ...fakeClient({
        title: "unused",
        metadata: { action: "heartbeat", status: "alive", sessionID: "session_status", backend: "remote" },
        output: "unused",
      }),
      executeSession: async (_linkID, payload): Promise<SynergyLinkSession.Result> => {
        actions.push(payload.action)
        return {
          title: "Session alive",
          metadata: { action: "heartbeat", status: "alive", sessionID: "session_status", backend: "remote" },
          output: "alive",
        }
      },
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_status",
      targetAgentID: "agent_status",
      sourceAgent: "build",
      sessionID: "session_status",
      status: "opened",
      openedAt: Date.now() - 60_000,
      lastUsedAt: Date.now() - 60_000,
    })
    try {
      const tool = await ConnectTool.init()
      const result = await tool.execute({ action: "status", linkID: "link_status", targetAgentID: "agent_status" }, ctx)

      expect(actions).toEqual(["heartbeat"])
      expect(result.metadata.status).toBe("opened")
      expect(result.metadata.sessionID).toBe("session_status")
      expect(SynergyLinkExecution.getSession("link_status")?.lastVerifiedAt).toBeGreaterThan(0)
    } finally {
      SynergyLinkExecution.setClient(null)
    }
  })

  test("status clears a session the host reports invalid and reports missing", async () => {
    SynergyLinkExecution.setClient({
      ...fakeClient({
        title: "unused",
        metadata: { action: "heartbeat", status: "alive", backend: "remote" },
        output: "unused",
      }),
      executeSession: async (): Promise<SynergyLinkSession.Result> => {
        throw new SynergyLinkRemoteError("session_invalid", "Session is not active.")
      },
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_status_invalid",
      targetAgentID: "agent_status_invalid",
      sourceAgent: "build",
      sessionID: "session_status_invalid",
      status: "opened",
      openedAt: Date.now() - 60_000,
      lastUsedAt: Date.now() - 60_000,
    })
    try {
      const tool = await ConnectTool.init()
      const result = await tool.execute(
        { action: "status", linkID: "link_status_invalid", targetAgentID: "agent_status_invalid" },
        ctx,
      )

      expect(result.metadata.status).toBe("missing")
      expect(SynergyLinkExecution.getSession("link_status_invalid")).toBeUndefined()
    } finally {
      SynergyLinkExecution.setClient(null)
    }
  })

  test("status reports unknown when the cached session heartbeat times out", async () => {
    const lastVerifiedAt = 1_000
    SynergyLinkExecution.setClient({
      ...fakeClient({
        title: "unused",
        metadata: { action: "heartbeat", status: "alive", backend: "remote" },
        output: "unused",
      }),
      executeSession: async (): Promise<SynergyLinkSession.Result> => {
        throw new SynergyLinkRemoteError("transport_error", "Timed out waiting for Synergy Link response.")
      },
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_status_timeout",
      targetAgentID: "agent_status_timeout",
      sourceAgent: "build",
      sessionID: "session_status_timeout",
      status: "opened",
      openedAt: Date.now() - 60_000,
      lastUsedAt: Date.now() - 60_000,
      lastVerifiedAt,
    })
    try {
      const tool = await ConnectTool.init()
      const result = await tool.execute(
        { action: "status", linkID: "link_status_timeout", targetAgentID: "agent_status_timeout" },
        ctx,
      )

      expect(result.metadata.status).toBe("unknown")
      expect(result.output).toContain("could not be verified")
      expect(SynergyLinkExecution.getSession("link_status_timeout")?.lastVerifiedAt).toBe(lastVerifiedAt)
    } finally {
      SynergyLinkExecution.setClient(null)
    }
  })

  test("open verifies a stale cached session before claiming already open", async () => {
    const actions: SynergyLinkSession.Action[] = []
    SynergyLinkExecution.setClient({
      ...fakeClient({
        title: "unused",
        metadata: { action: "open", status: "opened", backend: "remote" },
        output: "unused",
      }),
      executeSession: async (_linkID, payload): Promise<SynergyLinkSession.Result> => {
        actions.push(payload.action)
        return {
          title: "Session alive",
          metadata: { action: payload.action, status: "alive", sessionID: "session_open_verify", backend: "remote" },
          output: "alive",
        }
      },
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_open_verify",
      targetAgentID: "agent_open_verify",
      sourceAgent: "build",
      sessionID: "session_open_verify",
      status: "opened",
      openedAt: Date.now() - 60_000,
      lastUsedAt: Date.now() - 60_000,
    })
    try {
      const tool = await ConnectTool.init()
      const result = await tool.execute(
        { action: "open", linkID: "link_open_verify", targetAgentID: "agent_open_verify" },
        ctx,
      )

      expect(actions).toEqual(["heartbeat"])
      expect(result.metadata.status).toBe("opened")
      expect(result.output).toContain("already open")
    } finally {
      SynergyLinkExecution.setClient(null)
    }
  })

  test("open clears an invalid cached session and opens a fresh one with a new ID", async () => {
    const actions: SynergyLinkSession.Action[] = []
    let sessionCalls = 0
    SynergyLinkExecution.setClient({
      ...fakeClient({
        title: "unused",
        metadata: { action: "open", status: "opened", backend: "remote" },
        output: "unused",
      }),
      executeSession: async (_linkID, payload): Promise<SynergyLinkSession.Result> => {
        sessionCalls++
        actions.push(payload.action)
        if (payload.action === "heartbeat") {
          throw new SynergyLinkRemoteError("session_invalid", "Session is not active.")
        }
        return {
          title: "Session opened",
          metadata: {
            action: "open",
            status: "opened",
            sessionID: "session_fresh",
            backend: "remote",
            host: {
              type: "synergy_link.host.hello",
              linkID: "link_open_fresh",
              hostSessionID: "host_fresh",
              capabilities: {
                platform: "linux",
                arch: "x64",
                runtime: "bun",
                defaultShell: "sh",
                supportedShells: ["sh"],
                supportsPty: false,
                supportsSendKeys: true,
                supportsSoftKill: true,
                supportsProcessGroups: true,
                envCaseInsensitive: false,
                lineEndings: "lf",
              },
            },
          },
          output: "opened",
        }
      },
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_open_fresh",
      targetAgentID: "agent_open_fresh",
      sourceAgent: "build",
      sessionID: "session_stale",
      status: "opened",
      openedAt: Date.now() - 60_000,
      lastUsedAt: Date.now() - 60_000,
    })
    try {
      const tool = await ConnectTool.init()
      const result = await tool.execute(
        { action: "open", linkID: "link_open_fresh", targetAgentID: "agent_open_fresh" },
        ctx,
      )

      expect(sessionCalls).toBe(2)
      expect(actions).toEqual(["heartbeat", "open"])
      expect(result.metadata.status).toBe("opened")
      expect(result.metadata.sessionID).toBe("session_fresh")
      expect(SynergyLinkExecution.getSession("link_open_fresh")?.sessionID).toBe("session_fresh")
    } finally {
      SynergyLinkExecution.setClient(null)
    }
  })

  test("open reports unknown when a stale cached session heartbeat times out and does not open", async () => {
    let sessionCalls = 0
    SynergyLinkExecution.setClient({
      ...fakeClient({
        title: "unused",
        metadata: { action: "open", status: "opened", backend: "remote" },
        output: "unused",
      }),
      executeSession: async (): Promise<SynergyLinkSession.Result> => {
        sessionCalls++
        throw new SynergyLinkRemoteError("transport_error", "Timed out waiting for Synergy Link response.")
      },
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_open_timeout",
      targetAgentID: "agent_open_timeout",
      sourceAgent: "build",
      sessionID: "session_open_timeout",
      status: "opened",
      openedAt: Date.now() - 60_000,
      lastUsedAt: Date.now() - 60_000,
    })
    try {
      const tool = await ConnectTool.init()
      const result = await tool.execute(
        { action: "open", linkID: "link_open_timeout", targetAgentID: "agent_open_timeout" },
        ctx,
      )

      expect(sessionCalls).toBe(1)
      expect(result.metadata.status).toBe("unknown")
      expect(result.output).toContain("could not be verified")
    } finally {
      SynergyLinkExecution.setClient(null)
    }
  })

  test("close clears a stale session when the host reports it invalid", async () => {
    let sessionCalls = 0
    SynergyLinkExecution.setClient({
      ...fakeClient({
        title: "unused",
        metadata: { action: "close", status: "closed", backend: "remote" },
        output: "unused",
      }),
      executeSession: async (): Promise<SynergyLinkSession.Result> => {
        sessionCalls++
        throw new SynergyLinkRemoteError("session_not_found", "Session is not active.")
      },
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_close_stale",
      targetAgentID: "agent_close_stale",
      sourceAgent: "build",
      sessionID: "session_close_stale",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })
    try {
      const tool = await ConnectTool.init()
      const result = await tool.execute(
        { action: "close", linkID: "link_close_stale", targetAgentID: "agent_close_stale" },
        ctx,
      )

      expect(sessionCalls).toBe(1)
      expect(result.metadata.status).toBe("closed")
      expect(SynergyLinkExecution.getSession("link_close_stale")).toBeUndefined()
    } finally {
      SynergyLinkExecution.setClient(null)
    }
  })

  test("clear force-removes a stale cached session locally without a remote call", async () => {
    let sessionCalls = 0
    SynergyLinkExecution.setClient({
      ...fakeClient({
        title: "unused",
        metadata: { action: "close", status: "closed", backend: "remote" },
        output: "unused",
      }),
      executeSession: async (): Promise<SynergyLinkSession.Result> => {
        sessionCalls++
        throw new Error("unexpected session execution")
      },
    })
    SynergyLinkExecution.upsertSession({
      linkID: "link_force_clear",
      targetAgentID: "agent_force_clear",
      sourceAgent: "build",
      sessionID: "session_force_clear",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })
    try {
      const tool = await ConnectTool.init()
      const result = await tool.execute(
        { action: "clear", linkID: "link_force_clear", targetAgentID: "agent_force_clear" },
        ctx,
      )

      expect(sessionCalls).toBe(0)
      expect(result.metadata.status).toBe("cleared")
      expect(SynergyLinkExecution.getSession("link_force_clear")).toBeUndefined()
    } finally {
      SynergyLinkExecution.setClient(null)
    }
  })

  test("does not let another local agent clear a raw session", async () => {
    SynergyLinkExecution.setClient(
      fakeClient({
        title: "unused",
        metadata: { action: "close", status: "closed", backend: "remote" },
        output: "unused",
      }),
    )
    SynergyLinkExecution.upsertSession({
      linkID: "link_clear_owned",
      targetAgentID: "agent_clear_owned",
      sourceAgent: "build",
      sessionID: "session_clear_owned",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })
    try {
      const tool = await ConnectTool.init()
      await expect(
        tool.execute(
          { action: "clear", linkID: "link_clear_owned", targetAgentID: "agent_clear_owned" },
          { ...ctx, agent: "review" },
        ),
      ).rejects.toThrow("No active Synergy Link session")
      expect(SynergyLinkExecution.getSession("link_clear_owned")?.sessionID).toBe("session_clear_owned")
    } finally {
      SynergyLinkExecution.setClient(null)
    }
  })
})
