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
