import { afterEach, describe, expect, test } from "bun:test"
import type {
  SynergyLinkBash,
  SynergyLinkClient,
  SynergyLinkProcess,
  SynergyLinkSession,
} from "@ericsanchezok/synergy-link-protocol"
import { SynergyLinkTargetRuntime } from "../../src/synergy-link/target-runtime"
import { SynergyLinkTargetStore } from "../../src/synergy-link/target-store"
import { StoragePath } from "../../src/storage/path"
import { Storage } from "../../src/storage/storage"
import { SynergyLinkExecution } from "../../src/tool/synergy-link-execution"

afterEach(async () => {
  SynergyLinkExecution.setClient(null)
  await Storage.removeTree(StoragePath.synergyLinkTargetsRoot())
})

describe("Synergy Link target runtime", () => {
  test("probes a target, records host capabilities, and closes the temporary session", async () => {
    const actions: SynergyLinkSession.Action[] = []
    const client: SynergyLinkClient.ExecutionClient = {
      executeBash: async (): Promise<SynergyLinkBash.Result> => {
        throw new Error("unexpected bash execution")
      },
      executeProcess: async (): Promise<SynergyLinkProcess.Result> => {
        throw new Error("unexpected process execution")
      },
      executeSession: async (_linkID, payload): Promise<SynergyLinkSession.Result> => {
        actions.push(payload.action)
        return {
          title: payload.action === "open" ? "Opened" : "Closed",
          metadata: {
            action: payload.action,
            status: payload.action === "open" ? "opened" : "closed",
            sessionID: "session_probe",
            backend: "remote",
            host: {
              type: "synergy_link.host.hello",
              linkID: "link_probe",
              hostSessionID: "host_probe",
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
      },
    }
    SynergyLinkExecution.setClient(client)
    const target = await SynergyLinkTargetStore.create({
      name: "Probe Host",
      targetAgentID: "agent_probe",
      linkID: "link_probe",
    })

    const observed = await SynergyLinkTargetRuntime.probe(target.id)

    expect(actions).toEqual(["open", "close"])
    expect(observed.authorization).toBe("approved")
    expect(observed.lastProbe?.status).toBe("reachable")
    expect(observed.host?.capabilities).toEqual(expect.objectContaining({ platform: "linux", arch: "x64" }))
  })
  test("closes a temporary session when recording the host observation fails", async () => {
    const actions: SynergyLinkSession.Action[] = []
    SynergyLinkExecution.setClient({
      executeBash: async (): Promise<SynergyLinkBash.Result> => {
        throw new Error("unexpected bash execution")
      },
      executeProcess: async (): Promise<SynergyLinkProcess.Result> => {
        throw new Error("unexpected process execution")
      },
      executeSession: async (_linkID, payload): Promise<SynergyLinkSession.Result> => {
        actions.push(payload.action)
        return {
          title: payload.action === "open" ? "Opened" : "Closed",
          metadata: {
            action: payload.action,
            status: payload.action === "open" ? "opened" : "closed",
            sessionID: "session_mismatch",
            backend: "remote",
            host:
              payload.action === "open"
                ? {
                    type: "synergy_link.host.hello",
                    linkID: "link_other",
                    hostSessionID: "host_other",
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
                  }
                : undefined,
          },
          output: "ok",
        }
      },
    })
    const target = await SynergyLinkTargetStore.create({
      name: "Mismatched host",
      targetAgentID: "agent_mismatch",
      linkID: "link_expected",
    })

    await expect(SynergyLinkTargetRuntime.probe(target.id)).rejects.toThrow("host identity mismatch")
    expect(actions).toEqual(["open", "close"])
  })

  test("records a closed heartbeat response as a failed probe", async () => {
    SynergyLinkExecution.setClient({
      executeBash: async (): Promise<SynergyLinkBash.Result> => {
        throw new Error("unexpected bash execution")
      },
      executeProcess: async (): Promise<SynergyLinkProcess.Result> => {
        throw new Error("unexpected process execution")
      },
      executeSession: async (_linkID, payload): Promise<SynergyLinkSession.Result> => ({
        title: "Session closed",
        metadata: {
          action: payload.action,
          status: "closed",
          sessionID: "session_closed",
          backend: "remote",
        },
        output: "closed",
      }),
    })
    const target = await SynergyLinkTargetStore.create({
      name: "Closed host",
      targetAgentID: "agent_closed",
      linkID: "link_closed",
    })
    SynergyLinkExecution.upsertSession({
      linkID: target.linkID,
      targetID: target.id,
      targetAgentID: target.targetAgentID,
      sourceAgent: "build",
      sessionID: "session_closed",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })

    const observed = await SynergyLinkTargetRuntime.probe(target.id)

    expect(observed.lastProbe?.status).toBe("failed")
    expect(observed.authorization).toBe("unverified")
  })

  test("records a live heartbeat response as reachable", async () => {
    SynergyLinkExecution.setClient({
      executeBash: async (): Promise<SynergyLinkBash.Result> => {
        throw new Error("unexpected bash execution")
      },
      executeProcess: async (): Promise<SynergyLinkProcess.Result> => {
        throw new Error("unexpected process execution")
      },
      executeSession: async (_linkID, payload): Promise<SynergyLinkSession.Result> => ({
        title: "Session alive",
        metadata: {
          action: payload.action,
          status: "alive",
          sessionID: "session_alive",
          backend: "remote",
        },
        output: "alive",
      }),
    })
    const target = await SynergyLinkTargetStore.create({
      name: "Live host",
      targetAgentID: "agent_alive",
      linkID: "link_alive",
    })
    SynergyLinkExecution.upsertSession({
      linkID: target.linkID,
      targetID: target.id,
      targetAgentID: target.targetAgentID,
      sourceAgent: "build",
      sessionID: "session_alive",
      status: "opened",
      openedAt: Date.now(),
      lastUsedAt: Date.now(),
    })

    const observed = await SynergyLinkTargetRuntime.probe(target.id)

    expect(observed.lastProbe?.status).toBe("reachable")
    expect(observed.authorization).toBe("approved")
  })
})
