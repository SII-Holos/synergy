import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { SynergyLinkStore } from "../src/state/store"
import { SynergyLinkOwnerRegistry } from "../src/owner-registry"

const originalHome = process.env.SYNERGY_LINK_HOME

async function tempRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "synergy-link-store-test-"))
}

describe("synergy-link state store", () => {
  afterEach(() => {
    if (originalHome === undefined) delete process.env.SYNERGY_LINK_HOME
    else process.env.SYNERGY_LINK_HOME = originalHome
  })

  test("state writes use one root snapshot even when home changes concurrently", async () => {
    const firstRoot = await tempRoot()
    const secondRoot = await tempRoot()
    process.env.SYNERGY_LINK_HOME = firstRoot
    const state = await SynergyLinkStore.loadState()

    process.env.SYNERGY_LINK_HOME = secondRoot
    const write = SynergyLinkStore.saveState(state)
    process.env.SYNERGY_LINK_HOME = firstRoot
    await write

    const rawState = await readFile(path.join(secondRoot, "state.json"), "utf8")
    expect(JSON.parse(rawState).runtimeMode).toBe("standalone")
  })

  test("concurrent saves serialize in call order so the last write wins", async () => {
    const root = await tempRoot()
    process.env.SYNERGY_LINK_HOME = root
    const base = await SynergyLinkStore.loadState()

    const writes: Promise<void>[] = []
    for (let index = 0; index < 10; index += 1) {
      writes.push(SynergyLinkStore.saveState({ ...base, label: `label-${index}` }))
    }
    await Promise.all(writes)

    const rawState = await readFile(path.join(root, "state.json"), "utf8")
    expect(JSON.parse(rawState).label).toBe("label-9")
  })

  test("captures state at call time and propagates persistence failures", async () => {
    const root = await tempRoot()
    process.env.SYNERGY_LINK_HOME = root
    const state = await SynergyLinkStore.loadState()
    state.label = "captured"

    const write = SynergyLinkStore.saveState(state)
    state.label = "mutated"
    await write
    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8")).label).toBe("captured")

    process.env.SYNERGY_LINK_HOME = path.join(root, "state.json")
    await expect(SynergyLinkStore.saveState(state)).rejects.toThrow()
  })

  test("creates private runtime directories and state files", async () => {
    const root = await tempRoot()
    process.env.SYNERGY_LINK_HOME = root
    const state = await SynergyLinkStore.loadState()

    await SynergyLinkStore.saveState(state)
    await SynergyLinkOwnerRegistry.saveFile(state.ownerRegistry)

    expect((await stat(root)).mode & 0o777).toBe(0o700)
    expect((await stat(path.join(root, "logs"))).mode & 0o777).toBe(0o700)
    expect((await stat(path.join(root, "state.json"))).mode & 0o777).toBe(0o600)
    expect((await stat(path.join(root, "owner.json"))).mode & 0o777).toBe(0o600)
  })
})
