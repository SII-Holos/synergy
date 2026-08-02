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

  test("does not close a remotely reused probe session when the local cache is empty", async () => {
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
            sessionID: "session_reused",
            reused: payload.action === "open" ? true : undefined,
            backend: "remote",
          },
          output: "ok",
        } as SynergyLinkSession.Result
      },
    })
    const target = await SynergyLinkTargetStore.create({
      name: "Reused probe host",
      targetAgentID: "agent_probe",
      linkID: "link_probe_reused",
    })

    const observed = await SynergyLinkTargetRuntime.probe(target.id)

    expect(actions).toEqual(["open"])
    expect(observed.lastProbe?.status).toBe("reachable")
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

describe("Synergy Link target availability", () => {
  function connectedClient(): SynergyLinkClient.ExecutionClient {
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

  test("reports a persisted reachable probe as unknown after the transport disconnects", async () => {
    const target = await SynergyLinkTargetStore.create({
      name: "Disconnected host",
      targetAgentID: "agent_disconnected",
      linkID: "link_disconnected",
    })
    SynergyLinkExecution.setClient(connectedClient())
    await SynergyLinkTargetStore.recordProbe(target.id, { status: "reachable" })
    SynergyLinkExecution.setClient(null)

    const observed = SynergyLinkTargetRuntime.view(await SynergyLinkTargetStore.require(target.id))
    expect(observed.lastProbe?.status).toBe("reachable")
    expect(observed.availability).toBe("unknown")
  })

  test("reports a fresh persisted reachable probe as reachable while the transport is connected", async () => {
    const target = await SynergyLinkTargetStore.create({
      name: "Connected host",
      targetAgentID: "agent_connected",
      linkID: "link_connected",
    })
    SynergyLinkExecution.setClient(connectedClient())
    await SynergyLinkTargetStore.recordProbe(target.id, { status: "reachable" })

    const observed = SynergyLinkTargetRuntime.view(await SynergyLinkTargetStore.require(target.id))
    expect(observed.availability).toBe("reachable")
  })

  test("reports a stale persisted reachable probe as unreachable even while connected", async () => {
    const target = await SynergyLinkTargetStore.create({
      name: "Stale host",
      targetAgentID: "agent_stale",
      linkID: "link_stale",
    })
    const current = await SynergyLinkTargetStore.require(target.id)
    await Storage.write(StoragePath.synergyLinkTarget(target.id), {
      ...current,
      lastProbe: { status: "reachable", checkedAt: Date.now() - 6 * 60 * 1000 },
    })
    SynergyLinkExecution.setClient(connectedClient())

    const observed = SynergyLinkTargetRuntime.view(await SynergyLinkTargetStore.require(target.id))
    expect(observed.lastProbe?.status).toBe("reachable")
    expect(observed.availability).toBe("unreachable")
  })
})
