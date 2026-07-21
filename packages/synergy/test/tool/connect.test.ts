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
        expect.objectContaining({ id: target.id, name: "Build Mac", availability: "holos_offline" }),
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

  test("does not list unregistered sessions to other agents", async () => {
    SynergyLinkExecution.upsertSession({
      linkID: "link_unregistered",
      targetAgentID: "agent_unregistered",
      sourceAgent: "build",
      sessionID: "session_unregistered",
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
      SynergyLinkExecution.clearSession("link_unregistered")
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
    await SynergyLinkTargetStore.update(target.id, { enabled: false })
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
