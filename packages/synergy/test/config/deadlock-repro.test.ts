import { beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Config } from "../../src/config/config"
import { ConfigDomain } from "../../src/config/domain"
import { Global } from "../../src/global"

// Regression coverage for the PR #1059 deadlock: lock-holding update paths
// (domainUpdate / domainMutateWithChange / domainUpdateWithChange) previously
// re-entered Lock.write inside quarantineFile while already holding the
// non-reentrant domain write lock, hanging the request forever. quarantine
// now uses a non-blocking tryAcquireWrite: when a write transaction holds the
// lock, the broken file is skipped for quarantine and the transaction's
// writeDomainFile overwrites it with valid config instead.

function domainDir() {
  return ConfigDomain.directory(Global.Path.config)
}

async function writeBrokenEmailFragment(content: string) {
  await fs.mkdir(domainDir(), { recursive: true })
  await Bun.write(path.join(domainDir(), "110-email.jsonc"), content)
}

async function listDomainFiles() {
  try {
    return await fs.readdir(domainDir())
  } catch {
    return [] as string[]
  }
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`DEADLOCK: ${label} hung on quarantine lock`)), 5000),
    ),
  ])
}

describe("config lock safety with broken domain files", () => {
  beforeEach(async () => {
    // The per-process global config directory is shared with other config
    // test files (e.g. degraded.test.ts), which leave quarantined
    // `110-email.jsonc.invalid-*` files behind. Clean the email domain files
    // so every test starts from a deterministic state.
    const dir = domainDir()
    try {
      const entries = await fs.readdir(dir)
      for (const entry of entries) {
        if (entry === "110-email.jsonc" || entry.startsWith("110-email.jsonc.invalid-")) {
          await fs.rm(path.join(dir, entry), { force: true })
        }
      }
    } catch {
      // directory does not exist yet — nothing to clean
    }
  })
  test("domainUpdate does not deadlock and the transaction overwrites the broken file", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await writeBrokenEmailFragment("{ broken")
        const result = await withTimeout(
          Config.domainUpdate("email", { email: { enabled: true } } as Config.Info),
          "domainUpdate",
        )
        expect(result).toBeDefined()

        // The write transaction replaces the broken file instead of
        // quarantining it; the domain becomes readable again.
        const files = await listDomainFiles()
        expect(files).toContain("110-email.jsonc")
        expect(files.some((name) => name.startsWith("110-email.jsonc.invalid-"))).toBe(false)
        const text = await Bun.file(path.join(domainDir(), "110-email.jsonc")).text()
        expect(text).toContain('"email"')
      },
    })
  })

  test("domainMutateWithChange does not deadlock and the transaction overwrites the broken file", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await writeBrokenEmailFragment("{ broken")
        const result = await withTimeout(
          Config.domainMutateWithChange("email", (current) => ({ email: { ...current.email, enabled: true } })),
          "domainMutateWithChange",
        )
        expect(result).toBeDefined()

        const files = await listDomainFiles()
        expect(files).toContain("110-email.jsonc")
        expect(files.some((name) => name.startsWith("110-email.jsonc.invalid-"))).toBe(false)
        const text = await Bun.file(path.join(domainDir(), "110-email.jsonc")).text()
        expect(text).toContain('"email"')
      },
    })
  })

  test("domainUpdateWithChange does not deadlock and the transaction overwrites the broken file", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await writeBrokenEmailFragment("{ broken")
        const result = await withTimeout(
          Config.domainUpdateWithChange("email", { email: { enabled: true } } as Config.Info),
          "domainUpdateWithChange",
        )
        expect(result).toBeDefined()

        const files = await listDomainFiles()
        expect(files).toContain("110-email.jsonc")
        expect(files.some((name) => name.startsWith("110-email.jsonc.invalid-"))).toBe(false)
      },
    })
  })

  test("reload without a held write lock still quarantines the broken file", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await writeBrokenEmailFragment("{ broken")
        await Config.reload("global")

        const config = await Config.current()
        expect(config.email).toBeUndefined()

        const files = await listDomainFiles()
        const quarantined = files.filter((name) => name.startsWith("110-email.jsonc.invalid-"))
        expect(quarantined).toHaveLength(1)
        expect(files).not.toContain("110-email.jsonc")
      },
    })
  })
})
