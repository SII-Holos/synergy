import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { MetaSynergyCLIBackend } from "../src/cli-backend"
import { MetaSynergyStore } from "../src/state/store"

const originalHome = process.env.META_SYNERGY_HOME
const tempRoots: string[] = []

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meta-synergy-cli-mode-"))
  tempRoots.push(root)
  process.env.META_SYNERGY_HOME = root
})

afterAll(async () => {
  if (originalHome === undefined) {
    delete process.env.META_SYNERGY_HOME
  } else {
    process.env.META_SYNERGY_HOME = originalHome
  }
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("meta-synergy cli backend mode transitions", () => {
  test("standalone mode clears managed ownership when service is offline", async () => {
    const state = await MetaSynergyStore.loadState()
    state.runtimeMode = "managed"
    state.ownerRegistry.local.ownerIDs = ["synergy:test"]
    state.ownerRegistry.local.activeOwnerID = "synergy:test"
    state.ownerRegistry.local.leaseExpiresAt = Date.now() + 10_000
    await MetaSynergyStore.saveState(state)

    const result = (await MetaSynergyCLIBackend.enterStandaloneMode()) as {
      mode: string
      ownership: { local: { owned: boolean } }
      connectionStatus: string
    }
    expect(result.mode).toBe("standalone")
    expect(result.ownership.local.owned).toBe(false)
    expect(result.connectionStatus).toBe("disconnected")

    const next = await MetaSynergyStore.loadState()
    expect(next.runtimeMode).toBe("standalone")
    expect(next.ownerRegistry.local.activeOwnerID).toBeUndefined()
  })
})
