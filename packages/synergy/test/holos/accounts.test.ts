import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import fs from "node:fs/promises"

// ── Temporary home directory isolation ──────────────────────────────────
// HolosAccounts reads/writes ~/.synergy/data/auth/holos-accounts.json.
// We swap SYNERGY_TEST_HOME so Global.Path.root targets a temp dir.
const tmpDir = mkdtempSync(join(import.meta.dirname, "..", ".tmp-holos-accounts-"))
const origHome = process.env["SYNERGY_TEST_HOME"]

const authDir = join(tmpDir, ".synergy", "data", "auth")
const accountsPath = join(authDir, "holos-accounts.json")
const apiKeyPath = join(authDir, "api-key.json")

type HolosAccountsNamespace = typeof import("../../src/holos/accounts").HolosAccounts
let HolosAccounts: HolosAccountsNamespace

beforeAll(async () => {
  process.env["SYNERGY_TEST_HOME"] = tmpDir
  await fs.mkdir(authDir, { recursive: true })
  HolosAccounts = (await import("../../src/holos/accounts")).HolosAccounts
})

afterAll(() => {
  if (origHome !== undefined) {
    process.env["SYNERGY_TEST_HOME"] = origHome
  } else {
    delete process.env["SYNERGY_TEST_HOME"]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

// Each test gets a clean store.
beforeEach(async () => {
  await fs.rm(accountsPath, { force: true }).catch(() => {})
  await fs.rm(apiKeyPath, { force: true }).catch(() => {})
})

// ── Helpers ─────────────────────────────────────────────────────────────

async function accountsFile(): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await Bun.file(accountsPath).text()
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function apiKeyFile(): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await Bun.file(apiKeyPath).text()
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("HolosAccounts multi-account store", () => {
  // ── 1. Fresh store has no active credential / empty accounts ────────

  test("fresh store returns no active account and empty account list", async () => {
    const active = await HolosAccounts.getActiveAccount()
    expect(active).toBeUndefined()

    const accounts = await HolosAccounts.listAccounts()
    expect(accounts).toEqual([])
  })

  // ── 2. Saving A then B stores both and makes latest active ──────────

  test("saveAndActivateAccount stores credential and makes latest active", async () => {
    await HolosAccounts.saveAndActivateAccount("agent_a", "secret_a", "Account A")

    const activeAfterA = await HolosAccounts.getActiveAccount()
    expect(activeAfterA).toBeDefined()
    expect(activeAfterA!.agentId).toBe("agent_a")
    expect(activeAfterA!.agentSecret).toBe("secret_a")
    expect(activeAfterA!.label).toBe("Account A")

    await HolosAccounts.saveAndActivateAccount("agent_b", "secret_b", "Account B")

    // B should now be active (latest login wins)
    const activeAfterB = await HolosAccounts.getActiveAccount()
    expect(activeAfterB).toBeDefined()
    expect(activeAfterB!.agentId).toBe("agent_b")
    expect(activeAfterB!.agentSecret).toBe("secret_b")
    expect(activeAfterB!.label).toBe("Account B")

    // Both accounts should be present in the list
    const accounts = await HolosAccounts.listAccounts()
    const ids = accounts.map((a) => a.agentId).sort()
    expect(ids).toEqual(["agent_a", "agent_b"])
  })

  test("saving same agentId again overwrites secret and makes it active", async () => {
    await HolosAccounts.saveAndActivateAccount("agent_x", "old_secret", "Old")

    const list1 = await HolosAccounts.listAccounts()
    expect(list1).toHaveLength(1)

    // Re-login with updated secret
    await HolosAccounts.saveAndActivateAccount("agent_x", "new_secret", "Updated")

    const active = await HolosAccounts.getActiveAccount()
    expect(active!.agentId).toBe("agent_x")
    expect(active!.agentSecret).toBe("new_secret")
    expect(active!.label).toBe("Updated")

    // Still only one account (no duplicate agentId entries)
    const list2 = await HolosAccounts.listAccounts()
    expect(list2).toHaveLength(1)
  })

  // ── 3. Switching active account changes resolved credential ─────────

  test("setActiveAccount changes what getActiveAccount returns", async () => {
    await HolosAccounts.saveAndActivateAccount("agent_a", "secret_a", "Alpha")
    await HolosAccounts.saveAndActivateAccount("agent_b", "secret_b", "Beta")

    // B is active (latest saved)
    expect((await HolosAccounts.getActiveAccount())!.agentId).toBe("agent_b")

    // Switch to A
    await HolosAccounts.setActiveAccount("agent_a")

    const active = await HolosAccounts.getActiveAccount()
    expect(active!.agentId).toBe("agent_a")
    expect(active!.agentSecret).toBe("secret_a")
    expect(active!.label).toBe("Alpha")
  })

  test("setActiveAccount with unknown ID does nothing or throws clearly", async () => {
    await HolosAccounts.saveAndActivateAccount("agent_a", "secret_a")

    // Switching to a non-existent agentId should either no-op (stay on active)
    // or throw a clear error. Assert on the behavior once chosen.
    await expect(HolosAccounts.setActiveAccount("nonexistent")).rejects.toThrow()

    // Active should still be the same
    const active = await HolosAccounts.getActiveAccount()
    expect(active!.agentId).toBe("agent_a")
  })

  // ── 4. Removing active account leaves no active ─────────────────────

  test("deleteAccount with active account clears active state", async () => {
    await HolosAccounts.saveAndActivateAccount("agent_a", "secret_a", "Only")

    expect((await HolosAccounts.getActiveAccount())!.agentId).toBe("agent_a")

    await HolosAccounts.deleteAccount("agent_a")

    const active = await HolosAccounts.getActiveAccount()
    expect(active).toBeUndefined()

    const accounts = await HolosAccounts.listAccounts()
    expect(accounts).toEqual([])
  })

  test("deleteAccount with non-active account keeps active unchanged", async () => {
    await HolosAccounts.saveAndActivateAccount("agent_a", "secret_a", "Alpha")
    await HolosAccounts.saveAndActivateAccount("agent_b", "secret_b", "Beta")

    // B is active (latest saved)
    await HolosAccounts.deleteAccount("agent_a")

    const active = await HolosAccounts.getActiveAccount()
    expect(active!.agentId).toBe("agent_b")

    const accounts = await HolosAccounts.listAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0].agentId).toBe("agent_b")
  })

  // ── 5. Legacy migration from Auth.set("holos", ...) ─────────────────

  test("migrateFromLegacy converts api-key.json holos entry to multi-account store", async () => {
    // Set up legacy data as Auth.set("holos", ...) would
    const legacyEntry: Record<string, unknown> = {
      holos: {
        type: "holos",
        agentId: "legacy_agent",
        agentSecret: "legacy_secret",
      },
    }
    await Bun.write(apiKeyPath, JSON.stringify(legacyEntry, null, 2))

    // Run migration
    const result = await HolosAccounts.migrateFromLegacy()
    expect(result.migrated).toBe(true)

    // Verify new store has the legacy account as active
    const active = await HolosAccounts.getActiveAccount()
    expect(active).toBeDefined()
    expect(active!.agentId).toBe("legacy_agent")
    expect(active!.agentSecret).toBe("legacy_secret")

    // Verify old key was removed from api-key.json
    const keys = await apiKeyFile()
    expect(keys).toBeDefined()
    expect(keys!["holos"]).toBeUndefined()
  })

  test("migrateFromLegacy is idempotent when no legacy data exists", async () => {
    const result = await HolosAccounts.migrateFromLegacy()
    expect(result.migrated).toBe(false)
  })

  test("migrateFromLegacy when holos key is missing in api-key.json", async () => {
    // api-key.json has other providers but no holos
    const otherKeys: Record<string, unknown> = {
      anthropic: { type: "api", key: "sk-ant" },
    }
    await Bun.write(apiKeyPath, JSON.stringify(otherKeys, null, 2))

    const result = await HolosAccounts.migrateFromLegacy()
    expect(result.migrated).toBe(false)

    // Other keys should be preserved
    const keys = await apiKeyFile()
    expect(keys).toBeDefined()
    expect(keys!["anthropic"]).toBeDefined()
  })
})
