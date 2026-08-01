import { afterEach, describe, expect, test } from "bun:test"
import type {
  SynergyLinkBash,
  SynergyLinkClient,
  SynergyLinkProcess,
  SynergyLinkSession,
} from "@ericsanchezok/synergy-link-protocol"
import { StoragePath } from "../../src/storage/path"
import { Storage } from "../../src/storage/storage"
import { SynergyLinkTargetService } from "../../src/synergy-link/target-service"
import { SynergyLinkTargetStore } from "../../src/synergy-link/target-store"
import { SynergyLinkExecution } from "../../src/tool/synergy-link-execution"

function client(
  executeSession: SynergyLinkClient.ExecutionClient["executeSession"],
): SynergyLinkClient.ExecutionClient {
  return {
    executeBash: async (): Promise<SynergyLinkBash.Result> => {
      throw new Error("unexpected bash execution")
    },
    executeProcess: async (): Promise<SynergyLinkProcess.Result> => {
      throw new Error("unexpected process execution")
    },
    executeSession,
  }
}

afterEach(async () => {
  SynergyLinkExecution.setClient(null)
  await Storage.removeTree(StoragePath.synergyLinkTargetsRoot())
})

describe("Synergy Link target service", () => {
  test("closes an active remote session before removing its target", async () => {
    const calls: Array<{ linkID: string; payload: SynergyLinkSession.ExecutePayload; targetAgentID?: string }> = []
    SynergyLinkExecution.setClient(
      client(async (linkID, payload, options): Promise<SynergyLinkSession.Result> => {
        calls.push({ linkID, payload, targetAgentID: options?.targetAgentID })
        return {
          title: "Session closed",
          metadata: { action: "close", status: "closed", sessionID: "session_remove", backend: "remote" },
          output: "Closed.",
        }
      }),
    )
    const target = await SynergyLinkTargetStore.create({
      name: "Removed host",
      targetAgentID: "agent_remove",
      linkID: "link_remove",
    })
    SynergyLinkExecution.upsertSession({
      linkID: target.linkID,
      targetID: target.id,
      targetAgentID: target.targetAgentID,
      sourceAgent: "build",
      sessionID: "session_remove",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })

    await SynergyLinkTargetService.remove(target.id)

    expect(calls).toEqual([
      {
        linkID: target.linkID,
        payload: { action: "close", sessionID: "session_remove" },
        targetAgentID: target.targetAgentID,
      },
    ])
    expect(await SynergyLinkTargetStore.get(target.id)).toBeUndefined()
    expect(SynergyLinkExecution.getSession(target.linkID)).toBeUndefined()
  })

  test("still removes the target when its remote session cannot close", async () => {
    SynergyLinkExecution.setClient(
      client(async (): Promise<SynergyLinkSession.Result> => {
        throw new Error("transport offline")
      }),
    )
    const target = await SynergyLinkTargetStore.create({
      name: "Offline host",
      targetAgentID: "agent_offline",
      linkID: "link_offline",
    })
    SynergyLinkExecution.upsertSession({
      linkID: target.linkID,
      targetID: target.id,
      targetAgentID: target.targetAgentID,
      sourceAgent: "build",
      sessionID: "session_offline",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })

    await SynergyLinkTargetService.remove(target.id)

    expect(await SynergyLinkTargetStore.get(target.id)).toBeUndefined()
    expect(SynergyLinkExecution.getSession(target.linkID)).toBeUndefined()
  })
})

describe("Synergy Link target service relink", () => {
  test("probe-verifies the new locator, updates atomically, and clears the old session", async () => {
    const actions: SynergyLinkSession.Action[] = []
    SynergyLinkExecution.setClient(
      client(async (_linkID, payload): Promise<SynergyLinkSession.Result> => {
        actions.push(payload.action)
        return {
          title: payload.action === "open" ? "Opened" : "Closed",
          metadata: {
            action: payload.action,
            status: payload.action === "open" ? "opened" : "closed",
            sessionID: payload.action === "open" ? "session_new" : "session_old",
            backend: "remote",
            host: {
              type: "synergy_link.host.hello",
              linkID: "link_new",
              hostSessionID: "host_new",
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
          output: "ok",
        }
      }),
    )
    const target = await SynergyLinkTargetStore.create({
      name: "Relink service host",
      targetAgentID: "agent_old",
      linkID: "link_old",
      allowedAgents: ["build"],
    })
    SynergyLinkExecution.upsertSession({
      linkID: target.linkID,
      targetID: target.id,
      targetAgentID: target.targetAgentID,
      sourceAgent: "build",
      sessionID: "session_old",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })

    const updated = await SynergyLinkTargetService.update(target.id, {
      targetAgentID: "agent_new",
      linkID: "link_new",
    })

    expect(actions).toEqual(["open", "close"])
    expect(updated.targetAgentID).toBe("agent_new")
    expect(updated.linkID).toBe("link_new")
    expect(updated.name).toBe("Relink service host")
    expect(updated.allowedAgents).toEqual(["build"])
    expect(updated.authorization).toBe("approved")
    expect(updated.lastProbe?.status).toBe("reachable")
    expect(SynergyLinkExecution.getSession("link_old")).toBeUndefined()
  })

  test("rolls back and preserves the original target when the new locator probe fails", async () => {
    SynergyLinkExecution.setClient(
      client(async (): Promise<SynergyLinkSession.Result> => {
        throw new Error("connection refused")
      }),
    )
    const target = await SynergyLinkTargetStore.create({
      name: "Relink failure host",
      targetAgentID: "agent_old",
      linkID: "link_old",
      allowedAgents: ["build"],
    })

    await expect(
      SynergyLinkTargetService.update(target.id, {
        targetAgentID: "agent_new",
        linkID: "link_new",
      }),
    ).rejects.toThrow("connection refused")

    const unchanged = await SynergyLinkTargetStore.require(target.id)
    expect(unchanged.targetAgentID).toBe("agent_old")
    expect(unchanged.linkID).toBe("link_old")
    expect(unchanged.name).toBe("Relink failure host")
    expect(unchanged.allowedAgents).toEqual(["build"])
    expect(unchanged.authorization).toBe("unverified")
  })
})
