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

  test("loads the active account after synergy migrates legacy holos credentials", async () => {
    originalLinkHome = process.env.SYNERGY_LINK_HOME
    originalSynergyHome = process.env.SYNERGY_TEST_HOME

    const linkRoot = await createTempRoot()
    const synergyHome = await createTempRoot()
    process.env.SYNERGY_LINK_HOME = linkRoot
    process.env.SYNERGY_TEST_HOME = synergyHome

    const sharedPath = SynergyLinkHolosAuth.sharedAuthPath()
    const accountsPath = path.join(path.dirname(sharedPath), "holos-accounts.json")
    await mkdir(path.dirname(sharedPath), { recursive: true })
    await writeFile(sharedPath, "{}")
    await writeFile(
      accountsPath,
      JSON.stringify(
        {
          activeAccountId: "agent_active",
          accounts: {
            agent_inactive: {
              agentId: "agent_inactive",
              agentSecret: "secret_inactive",
              createdAt: 1,
              updatedAt: 1,
            },
            agent_active: {
              agentId: "agent_active",
              agentSecret: "secret_active",
              createdAt: 2,
              updatedAt: 2,
            },
          },
        },
        null,
        2,
      ),
    )

    await expect(SynergyLinkHolosAuth.inspect()).resolves.toEqual({
      auth: {
        agentID: "agent_active",
        agentSecret: "secret_active",
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

  test("does not resurrect legacy credentials after the canonical store logs out", async () => {
    originalLinkHome = process.env.SYNERGY_LINK_HOME
    originalSynergyHome = process.env.SYNERGY_TEST_HOME

    const linkRoot = await createTempRoot()
    const synergyHome = await createTempRoot()
    process.env.SYNERGY_LINK_HOME = linkRoot
    process.env.SYNERGY_TEST_HOME = synergyHome

    const sharedPath = SynergyLinkHolosAuth.sharedAuthPath()
    const accountsPath = path.join(path.dirname(sharedPath), "holos-accounts.json")
    await mkdir(path.dirname(sharedPath), { recursive: true })
    await writeFile(
      sharedPath,
      JSON.stringify({ holos: { type: "holos", agentId: "agent_legacy", agentSecret: "secret_legacy" } }),
    )
    await writeFile(accountsPath, JSON.stringify({ activeAccountId: null, accounts: {} }))

    await expect(SynergyLinkHolosAuth.inspect()).resolves.toEqual({
      auth: undefined,
      source: null,
    })
  })

  test("save activates the account in the canonical store and preserves other accounts", async () => {
    originalLinkHome = process.env.SYNERGY_LINK_HOME
    originalSynergyHome = process.env.SYNERGY_TEST_HOME

    const linkRoot = await createTempRoot()
    const synergyHome = await createTempRoot()
    process.env.SYNERGY_LINK_HOME = linkRoot
    process.env.SYNERGY_TEST_HOME = synergyHome

    const accountsPath = path.join(synergyHome, ".synergy", "data", "auth", "holos-accounts.json")
    const sharedPath = SynergyLinkHolosAuth.sharedAuthPath()
    await mkdir(path.dirname(accountsPath), { recursive: true })
    await writeFile(
      accountsPath,
      JSON.stringify({
        activeAccountId: "agent_existing",
        accounts: {
          agent_existing: {
            agentId: "agent_existing",
            agentSecret: "secret_existing",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      }),
    )
    await writeFile(
      sharedPath,
      JSON.stringify({
        another: { type: "api", key: "keep-me" },
        holos: { type: "holos", agentId: "agent_stale", agentSecret: "secret_stale" },
      }),
    )

    await SynergyLinkHolosAuth.save({ agentID: "agent_new", agentSecret: "secret_new" })

    const stored = JSON.parse(await readFile(accountsPath, "utf8")) as {
      activeAccountId: string | null
      accounts: Record<string, { agentId: string; agentSecret: string; createdAt: number; updatedAt: number }>
    }
    expect(stored.activeAccountId).toBe("agent_new")
    expect(stored.accounts.agent_existing).toEqual({
      agentId: "agent_existing",
      agentSecret: "secret_existing",
      createdAt: 1,
      updatedAt: 1,
    })
    expect(stored.accounts.agent_new?.agentSecret).toBe("secret_new")
    expect(stored.accounts.agent_new?.createdAt).toBeNumber()
    expect(stored.accounts.agent_new?.updatedAt).toBeNumber()

    const legacy = JSON.parse(await readFile(sharedPath, "utf8")) as Record<string, unknown>
    expect(legacy).toHaveProperty("another")
    expect(legacy).not.toHaveProperty("holos")
  })

  test("save refuses to replace a malformed canonical account store", async () => {
    originalLinkHome = process.env.SYNERGY_LINK_HOME
    originalSynergyHome = process.env.SYNERGY_TEST_HOME

    const linkRoot = await createTempRoot()
    const synergyHome = await createTempRoot()
    process.env.SYNERGY_LINK_HOME = linkRoot
    process.env.SYNERGY_TEST_HOME = synergyHome

    const accountsPath = path.join(synergyHome, ".synergy", "data", "auth", "holos-accounts.json")
    await mkdir(path.dirname(accountsPath), { recursive: true })
    await writeFile(accountsPath, "not-json")

    await expect(SynergyLinkHolosAuth.save({ agentID: "agent_new", agentSecret: "secret_new" })).rejects.toThrow(
      "Failed to parse the shared Holos account store",
    )
    await expect(readFile(accountsPath, "utf8")).resolves.toBe("not-json")
  })

  test("clear removes the active canonical account and legacy fallback while preserving other accounts", async () => {
    originalLinkHome = process.env.SYNERGY_LINK_HOME
    originalSynergyHome = process.env.SYNERGY_TEST_HOME

    const linkRoot = await createTempRoot()
    const synergyHome = await createTempRoot()
    process.env.SYNERGY_LINK_HOME = linkRoot
    process.env.SYNERGY_TEST_HOME = synergyHome

    const sharedPath = SynergyLinkHolosAuth.sharedAuthPath()
    const accountsPath = path.join(path.dirname(sharedPath), "holos-accounts.json")
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
    await writeFile(
      accountsPath,
      JSON.stringify({
        activeAccountId: "agent_clear",
        accounts: {
          agent_keep: {
            agentId: "agent_keep",
            agentSecret: "secret_keep",
            createdAt: 1,
            updatedAt: 1,
          },
          agent_clear: {
            agentId: "agent_clear",
            agentSecret: "secret_clear",
            createdAt: 2,
            updatedAt: 2,
          },
        },
      }),
    )

    await SynergyLinkHolosAuth.clear()

    await expect(SynergyLinkHolosAuth.inspect()).resolves.toEqual({
      auth: undefined,
      source: null,
    })

    await expect(access(path.join(linkRoot, "auth.json"))).rejects.toThrow()
    await expect(readFile(sharedPath, "utf8")).resolves.toContain('"another"')
    await expect(readFile(sharedPath, "utf8")).resolves.not.toContain('"holos"')

    const stored = JSON.parse(await readFile(accountsPath, "utf8")) as {
      activeAccountId: string | null
      accounts: Record<string, unknown>
    }
    expect(stored.activeAccountId).toBeNull()
    expect(stored.accounts).toHaveProperty("agent_keep")
    expect(stored.accounts).not.toHaveProperty("agent_clear")
  })
})
