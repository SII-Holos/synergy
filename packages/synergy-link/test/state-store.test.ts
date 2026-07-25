import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { SynergyLinkStore } from "../src/state/store"

const originalHome = process.env.SYNERGY_LINK_HOME
const tempRoots: string[] = []

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-link-store-test-"))
  tempRoots.push(root)
  return root
}

describe("synergy-link state store", () => {
  afterEach(async () => {
    if (originalHome === undefined) delete process.env.SYNERGY_LINK_HOME
    else process.env.SYNERGY_LINK_HOME = originalHome
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
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

  test("state writes snapshot mutable input at call time", async () => {
    const root = await tempRoot()
    process.env.SYNERGY_LINK_HOME = root
    const state = await SynergyLinkStore.loadState()
    state.label = "captured"

    const write = SynergyLinkStore.saveState(state)
    state.label = "mutated-after-call"
    await write

    expect(JSON.parse(await readFile(path.join(root, "state.json"), "utf8")).label).toBe("captured")
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

  test("state saves reject write failures", async () => {
    const healthyRoot = await tempRoot()
    process.env.SYNERGY_LINK_HOME = healthyRoot
    const state = await SynergyLinkStore.loadState()
    const blockedRoot = path.join(healthyRoot, "not-a-directory")
    await writeFile(blockedRoot, "blocked")
    process.env.SYNERGY_LINK_HOME = blockedRoot

    await expect(SynergyLinkStore.saveState(state)).rejects.toThrow()
  })

  test("malformed persisted state fails explicitly", async () => {
    const root = await tempRoot()
    process.env.SYNERGY_LINK_HOME = root
    await writeFile(path.join(root, "state.json"), "{not-json")

    await expect(SynergyLinkStore.loadState()).rejects.toThrow("Failed to parse Synergy Link state")
  })

  test("creates private runtime files through atomic replacement", async () => {
    const root = await tempRoot()
    process.env.SYNERGY_LINK_HOME = root
    const state = await SynergyLinkStore.loadState()

    await SynergyLinkStore.saveState(state)

    expect((await readdir(root)).filter((name) => name.includes(".tmp"))).toEqual([])
    if (process.platform !== "win32") {
      expect((await stat(root)).mode & 0o777).toBe(0o700)
      expect((await stat(path.join(root, "logs"))).mode & 0o777).toBe(0o700)
      expect((await stat(path.join(root, "state.json"))).mode & 0o777).toBe(0o600)
    }
  })
})
