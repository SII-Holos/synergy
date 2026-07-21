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
})
