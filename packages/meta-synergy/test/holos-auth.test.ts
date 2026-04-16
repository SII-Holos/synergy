import { afterEach, describe, expect, test } from "bun:test"
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { MetaSynergyHolosAuth } from "../src/holos/auth"
import { MetaSynergyStore } from "../src/state/store"

async function createTempRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "meta-synergy-auth-test-"))
}

describe("meta-synergy holos auth", () => {
  let originalMetaHome: string | undefined
  let originalSynergyHome: string | undefined

  afterEach(() => {
    if (originalMetaHome === undefined) delete process.env.META_SYNERGY_HOME
    else process.env.META_SYNERGY_HOME = originalMetaHome

    if (originalSynergyHome === undefined) delete process.env.SYNERGY_TEST_HOME
    else process.env.SYNERGY_TEST_HOME = originalSynergyHome
  })

  test("loads shared synergy holos credentials", async () => {
    originalMetaHome = process.env.META_SYNERGY_HOME
    originalSynergyHome = process.env.SYNERGY_TEST_HOME

    const metaRoot = await createTempRoot()
    const synergyHome = await createTempRoot()
    process.env.META_SYNERGY_HOME = metaRoot
    process.env.SYNERGY_TEST_HOME = synergyHome

    const sharedPath = MetaSynergyHolosAuth.sharedAuthPath()
    await mkdir(path.dirname(sharedPath), { recursive: true })
    await writeFile(
      sharedPath,
      JSON.stringify({ holos: { type: "holos", agentId: "agent_shared", agentSecret: "secret_shared" } }, null, 2),
    )

    await expect(MetaSynergyHolosAuth.inspect()).resolves.toEqual({
      auth: {
        agentID: "agent_shared",
        agentSecret: "secret_shared",
      },
      source: "shared",
    })
  })

  test("falls back to legacy auth and migrates it to shared store", async () => {
    originalMetaHome = process.env.META_SYNERGY_HOME
    originalSynergyHome = process.env.SYNERGY_TEST_HOME

    const metaRoot = await createTempRoot()
    const synergyHome = await createTempRoot()
    process.env.META_SYNERGY_HOME = metaRoot
    process.env.SYNERGY_TEST_HOME = synergyHome

    await MetaSynergyStore.saveLegacyAuth({ agentID: "agent_legacy", agentSecret: "secret_legacy" })

    await expect(MetaSynergyHolosAuth.inspect()).resolves.toEqual({
      auth: {
        agentID: "agent_legacy",
        agentSecret: "secret_legacy",
      },
      source: "legacy-migrated",
    })

    const sharedPath = MetaSynergyHolosAuth.sharedAuthPath()
    const shared = JSON.parse(await readFile(sharedPath, "utf8")) as {
      holos: { type: string; agentId: string; agentSecret: string }
    }

    expect(shared.holos).toEqual({
      type: "holos",
      agentId: "agent_legacy",
      agentSecret: "secret_legacy",
    })
  })

  test("clear removes holos credentials from shared and legacy stores", async () => {
    originalMetaHome = process.env.META_SYNERGY_HOME
    originalSynergyHome = process.env.SYNERGY_TEST_HOME

    const metaRoot = await createTempRoot()
    const synergyHome = await createTempRoot()
    process.env.META_SYNERGY_HOME = metaRoot
    process.env.SYNERGY_TEST_HOME = synergyHome

    await MetaSynergyStore.saveLegacyAuth({ agentID: "agent_clear", agentSecret: "secret_clear" })

    const sharedPath = MetaSynergyHolosAuth.sharedAuthPath()
    await mkdir(path.dirname(sharedPath), { recursive: true })
    await writeFile(
      sharedPath,
      JSON.stringify(
        {
          another: { type: "token", value: "keep-me" },
          holos: { type: "holos", agentId: "agent_clear", agentSecret: "secret_clear" },
        },
        null,
        2,
      ),
    )

    await MetaSynergyHolosAuth.clear()

    await expect(MetaSynergyHolosAuth.inspect()).resolves.toEqual({
      auth: undefined,
      source: null,
    })

    await expect(access(MetaSynergyStore.legacyAuthPath())).rejects.toThrow()
    await expect(readFile(sharedPath, "utf8")).resolves.toContain('"another"')
    await expect(readFile(sharedPath, "utf8")).resolves.not.toContain('"holos"')
  })
})
