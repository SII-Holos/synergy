import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { SynergyLinkMigrationRunner } from "../src/migration"
import { SynergyLinkStore } from "../src/state/store"

async function createTempRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "synergy-link-migration-test-"))
}

describe("synergy-link migration runner", () => {
  let originalSynergyLinkHome: string | undefined
  let originalMetaSynergyHome: string | undefined

  afterEach(() => {
    if (originalSynergyLinkHome === undefined) delete process.env.SYNERGY_LINK_HOME
    else process.env.SYNERGY_LINK_HOME = originalSynergyLinkHome

    if (originalMetaSynergyHome === undefined) delete process.env.META_SYNERGY_HOME
    else process.env.META_SYNERGY_HOME = originalMetaSynergyHome
  })

  test("normalizes persisted state and records migration", async () => {
    originalSynergyLinkHome = process.env.SYNERGY_LINK_HOME
    originalMetaSynergyHome = process.env.META_SYNERGY_HOME
    const root = await createTempRoot()
    process.env.SYNERGY_LINK_HOME = root
    delete process.env.META_SYNERGY_HOME

    await writeFile(
      SynergyLinkStore.statePath(),
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

    await SynergyLinkMigrationRunner.run()

    const state = await SynergyLinkStore.loadState()
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

    const log = JSON.parse(await readFile(SynergyLinkStore.migrationLogPath(), "utf8")) as Record<string, number>
    expect(typeof log["20260408-normalize-state"]).toBe("number")
  })

  test("cuts over legacy state into normalized link state and preserves imported migration log", async () => {
    originalSynergyLinkHome = process.env.SYNERGY_LINK_HOME
    originalMetaSynergyHome = process.env.META_SYNERGY_HOME
    const root = await createTempRoot()
    const legacyRoot = await createTempRoot()
    process.env.SYNERGY_LINK_HOME = root
    process.env.META_SYNERGY_HOME = legacyRoot

    await writeFile(
      path.join(legacyRoot, "state.json"),
      JSON.stringify({
        envID: "env_abc123",
        approvalMode: "invalid",
        trusted: { agentIDs: ["agent", "agent"], ownerUserIDs: [7, 7] },
        blockedAgentIDs: ["blocked", "blocked"],
        connectionStatus: "connected",
        service: { desiredState: "running", runtimeStatus: "running", pid: 123, printLogs: true },
        logs: { filePath: path.join(legacyRoot, "logs", "runtime.log") },
      }),
    )
    await writeFile(path.join(legacyRoot, "migrations.json"), JSON.stringify({ "old-migration": 1 }, null, 2))

    await SynergyLinkMigrationRunner.run()

    const state = await SynergyLinkStore.loadState()
    expect(state.linkID).toBe("link_abc123")
    expect(state.approvalMode).toBe("manual")
    expect(state.trusted.agentIDs).toEqual(["agent"])
    expect(state.trusted.ownerUserIDs).toEqual([7])
    expect(state.blockedAgentIDs).toEqual(["blocked"])
    expect(state.connectionStatus).toBe("disconnected")
    expect(state.service.desiredState).toBe("stopped")
    expect(state.service.runtimeStatus).toBe("stopped")
    expect(state.service.pid).toBeUndefined()
    expect(state.logs.filePath).toBe(SynergyLinkStore.logsPath())

    const rawState = await readFile(SynergyLinkStore.statePath(), "utf8")
    expect(rawState).not.toContain("envID")

    const log = JSON.parse(await readFile(SynergyLinkStore.migrationLogPath(), "utf8")) as Record<string, number>
    expect(log["old-migration"]).toBe(1)
    expect(typeof log["20260705-meta-synergy-to-synergy-link"]).toBe("number")
    expect(typeof log["20260408-normalize-state"]).toBe("number")
  })
})
