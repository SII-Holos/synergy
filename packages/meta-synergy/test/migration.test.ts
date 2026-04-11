import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { MetaSynergyMigrationRunner } from "../src/migration"
import { MetaSynergyStore } from "../src/state/store"

async function createTempRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "meta-synergy-migration-test-"))
}

describe("meta-synergy migration runner", () => {
  let originalMetaHome: string | undefined

  afterEach(() => {
    if (originalMetaHome === undefined) delete process.env.META_SYNERGY_HOME
    else process.env.META_SYNERGY_HOME = originalMetaHome
  })

  test("normalizes persisted state and records migration", async () => {
    originalMetaHome = process.env.META_SYNERGY_HOME
    const root = await createTempRoot()
    process.env.META_SYNERGY_HOME = root

    await writeFile(
      MetaSynergyStore.statePath(),
      JSON.stringify({
        collaborationEnabled: true,
        approvalMode: "invalid",
        trusted: { agentIDs: ["a", "a"], ownerUserIDs: [1, 1] },
        pendingRequests: [{ id: "r1", callerAgentID: "agent", callerOwnerUserID: 7, requestedAt: 1, status: "weird" }],
        blockedAgentIDs: ["b", "b"],
        connectionStatus: "mystery",
        service: { desiredState: "maybe", runtimeStatus: "wat", pid: "oops", printLogs: true },
        logs: { filePath: "" },
      }),
    )

    await MetaSynergyMigrationRunner.run()

    const state = await MetaSynergyStore.loadState()
    expect(state.runtimeMode).toBe("standalone")
    expect(state.ownerRegistry.local.ownerIDs).toEqual([])
    expect(state.approvalMode).toBe("manual")
    expect(state.blockedAgentIDs).toEqual(["b"])
    expect(state.trusted.agentIDs).toEqual(["a"])
    expect(state.trusted.ownerUserIDs).toEqual([1])
    expect(state.connectionStatus).toBe("disconnected")
    expect(state.service.desiredState).toBe("stopped")
    expect(state.service.runtimeStatus).toBe("stopped")
    expect(state.service.pid).toBeUndefined()
    expect(state.pendingRequests[0]?.status).toBe("pending")

    const log = JSON.parse(await readFile(MetaSynergyStore.migrationLogPath(), "utf8")) as Record<string, number>
    expect(typeof log["20260408-normalize-state"]).toBe("number")
  })
})
