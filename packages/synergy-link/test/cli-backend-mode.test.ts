import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { SynergyLinkCLIBackend } from "../src/cli-backend"
import { SynergyLinkStore } from "../src/state/store"

const originalHome = process.env.SYNERGY_LINK_HOME
const tempRoots: string[] = []

beforeEach(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-cli-mode-"))
  tempRoots.push(root)
  process.env.SYNERGY_LINK_HOME = root
})

afterAll(async () => {
  if (originalHome === undefined) {
    delete process.env.SYNERGY_LINK_HOME
  } else {
    process.env.SYNERGY_LINK_HOME = originalHome
  }
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe("synergy-link cli backend mode transitions", () => {
  test("standalone mode clears managed ownership when service is offline", async () => {
    const state = await SynergyLinkStore.loadState()
    state.runtimeMode = "managed"
    state.ownerRegistry.local.ownerIDs = ["synergy:test"]
    state.ownerRegistry.local.activeOwnerID = "synergy:test"
    state.ownerRegistry.local.leaseExpiresAt = Date.now() + 10_000
    await SynergyLinkStore.saveState(state)

    const result = (await SynergyLinkCLIBackend.enterStandaloneMode()) as {
      mode: string
      ownership: { local: { owned: boolean } }
      connectionStatus: string
    }
    expect(result.mode).toBe("standalone")
    expect(result.ownership.local.owned).toBe(false)
    expect(result.connectionStatus).toBe("disconnected")

    const next = await SynergyLinkStore.loadState()
    expect(next.runtimeMode).toBe("standalone")
    expect(next.ownerRegistry.local.activeOwnerID).toBeUndefined()
  })
})
