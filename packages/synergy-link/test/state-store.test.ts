import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { SynergyLinkStore } from "../src/state/store"

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
})
