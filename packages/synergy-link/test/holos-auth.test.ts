import { afterEach, describe, expect, test } from "bun:test"
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { SynergyLinkHolosAuth } from "../src/holos/auth"

async function createTempRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "synergy-link-auth-test-"))
}

describe("synergy-link holos auth", () => {
  let originalLinkHome: string | undefined
  let originalSynergyHome: string | undefined

  afterEach(() => {
    if (originalLinkHome === undefined) delete process.env.SYNERGY_LINK_HOME
    else process.env.SYNERGY_LINK_HOME = originalLinkHome

    if (originalSynergyHome === undefined) delete process.env.SYNERGY_TEST_HOME
    else process.env.SYNERGY_TEST_HOME = originalSynergyHome
  })

  test("loads shared synergy holos credentials", async () => {
    originalLinkHome = process.env.SYNERGY_LINK_HOME
    originalSynergyHome = process.env.SYNERGY_TEST_HOME

    const linkRoot = await createTempRoot()
    const synergyHome = await createTempRoot()
    process.env.SYNERGY_LINK_HOME = linkRoot
    process.env.SYNERGY_TEST_HOME = synergyHome

    const sharedPath = SynergyLinkHolosAuth.sharedAuthPath()
    await mkdir(path.dirname(sharedPath), { recursive: true })
    await writeFile(
      sharedPath,
      JSON.stringify({ holos: { type: "holos", agentId: "agent_shared", agentSecret: "secret_shared" } }, null, 2),
    )

    await expect(SynergyLinkHolosAuth.inspect()).resolves.toEqual({
      auth: {
        agentID: "agent_shared",
        agentSecret: "secret_shared",
      },
      source: "shared",
    })
  })

  test("does not read old root auth during steady-state inspection", async () => {
    originalLinkHome = process.env.SYNERGY_LINK_HOME
    originalSynergyHome = process.env.SYNERGY_TEST_HOME

    const linkRoot = await createTempRoot()
    const synergyHome = await createTempRoot()
    process.env.SYNERGY_LINK_HOME = linkRoot
    process.env.SYNERGY_TEST_HOME = synergyHome

    await writeFile(
      path.join(linkRoot, "auth.json"),
      JSON.stringify({ agentID: "agent_legacy", agentSecret: "secret_legacy" }, null, 2),
    )

    await expect(SynergyLinkHolosAuth.inspect()).resolves.toEqual({
      auth: undefined,
      source: null,
    })
  })

  test("clear removes holos credentials from shared store only", async () => {
    originalLinkHome = process.env.SYNERGY_LINK_HOME
    originalSynergyHome = process.env.SYNERGY_TEST_HOME

    const linkRoot = await createTempRoot()
    const synergyHome = await createTempRoot()
    process.env.SYNERGY_LINK_HOME = linkRoot
    process.env.SYNERGY_TEST_HOME = synergyHome

    const sharedPath = SynergyLinkHolosAuth.sharedAuthPath()
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

    await SynergyLinkHolosAuth.clear()

    await expect(SynergyLinkHolosAuth.inspect()).resolves.toEqual({
      auth: undefined,
      source: null,
    })

    await expect(access(path.join(linkRoot, "auth.json"))).rejects.toThrow()
    await expect(readFile(sharedPath, "utf8")).resolves.toContain('"another"')
    await expect(readFile(sharedPath, "utf8")).resolves.not.toContain('"holos"')
  })
})
