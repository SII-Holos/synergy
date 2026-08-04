import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { Config } from "../../src/config/config"
import { ConfigDomain } from "../../src/config/domain"
import { Global } from "../../src/global"

// The preload sets SYNERGY_TEST_HOME to a per-process temp home. The global
// domain directory therefore resolves under that temp home, which lets these
// tests plant broken fragment files without touching a real user config.

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

describe("degraded config isolation", () => {
  test("syntax error in a global domain fragment is quarantined and skipped", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await writeBrokenEmailFragment("{ email: { smtp: { host: 'smtp.example.com' } ")
        await Config.reload("global")

        const config = await Config.current()
        expect(config.email).toBeUndefined()

        const files = await listDomainFiles()
        const quarantined = files.filter((name) => name.startsWith("110-email.jsonc.invalid-"))
        expect(quarantined).toHaveLength(1)
        expect(files).not.toContain("110-email.jsonc")

        const issues = await Config.diagnostics()
        expect(issues.some((issue) => issue.path.endsWith("110-email.jsonc"))).toBe(true)
      },
    })
  })

  test("root type error in a global domain fragment is quarantined and skipped", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await writeBrokenEmailFragment("[1, 2, 3]")
        await Config.reload("global")

        const config = await Config.current()
        expect(config.email).toBeUndefined()

        const files = await listDomainFiles()
        expect(files.some((name) => name.startsWith("110-email.jsonc.invalid-"))).toBe(true)
      },
    })
  })

  test("top-level key that belongs to another domain is quarantined and skipped", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // "model" is a valid top-level key but belongs to the models domain;
        // validateKeys rejects it inside the email domain file.
        await writeBrokenEmailFragment('{ "email": { "enabled": true }, "model": "deepseek/deepseek-v4-pro" }')
        await Config.reload("global")

        const config = await Config.current()
        expect(config.email).toBeUndefined()

        const files = await listDomainFiles()
        expect(files.some((name) => name.startsWith("110-email.jsonc.invalid-"))).toBe(true)
      },
    })
  })

  test("section-level schema errors keep the existing strip recovery (regression)", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // 10-models.jsonc with a bad top-level section value: strip should
        // remove the section and keep the file (no quarantine).
        await fs.mkdir(domainDir(), { recursive: true })
        await Bun.write(
          path.join(domainDir(), "10-models.jsonc"),
          JSON.stringify({ model: "deepseek/deepseek-v4-pro", thinking_model: 42 }),
        )
        await Config.reload("global")

        const config = await Config.current()
        // Section stripped, defaults applied, no crash
        expect(config.model).toBe("deepseek/deepseek-v4-pro")

        const files = await listDomainFiles()
        expect(files).toContain("10-models.jsonc")
        expect(files.some((name) => name.startsWith("10-models.jsonc.invalid-"))).toBe(false)
      },
    })
  })

  test("reload keeps the previous config when a broken legacy file appears", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // First load a valid email config.
        await Config.domainUpdate("email", { email: { enabled: true } } as Config.Info)
        await Config.reload("global")
        expect((await Config.current()).email?.enabled).toBe(true)

        // A broken legacy config must not wipe the already-loaded config:
        // the legacy file is quarantined and the reload completes with the
        // email domain still present.
        const legacy = path.join(Global.Path.config, "synergy.jsonc")
        await Bun.write(legacy, "{ broken")
        await Config.reload("global")

        const config = await Config.current()
        expect(config.email?.enabled).toBe(true)
      },
    })
  })

  test("legacy global config with a syntax error is quarantined and migration skipped", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const legacy = path.join(Global.Path.config, "synergy.jsonc")
        await fs.mkdir(Global.Path.config, { recursive: true })
        await Bun.write(legacy, "{ broken legacy")
        await Config.reload("global")

        const config = await Config.current()
        expect(config).toBeDefined()

        const files = await fs.readdir(Global.Path.config)
        expect(files.some((name) => name.startsWith("synergy.jsonc.invalid-"))).toBe(true)
      },
    })
  })

  test("domainGet returns empty for a quarantined domain", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await writeBrokenEmailFragment("{ broken")
        await Config.reload("global")
        const email = await Config.domainGet("email")
        expect(email).toEqual({})
      },
    })
  })

  test("multiple broken fragments are all quarantined and reported", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await writeBrokenEmailFragment("{ broken email")
        await fs.mkdir(domainDir(), { recursive: true })
        await Bun.write(path.join(domainDir(), "10-models.jsonc"), "{ broken models")
        await Config.reload("global")

        const config = await Config.current()
        expect(config.email).toBeUndefined()
        expect(config.model).toBeUndefined()

        const files = await listDomainFiles()
        expect(files.some((name) => name.startsWith("110-email.jsonc.invalid-"))).toBe(true)
        expect(files.some((name) => name.startsWith("10-models.jsonc.invalid-"))).toBe(true)

        const issues = await Config.diagnostics()
        expect(issues.filter((issue) => issue.quarantined).length).toBeGreaterThanOrEqual(2)
      },
    })
  })
  test("diagnostics never expose raw config content or resolved env secrets", async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        // A syntax error in a file that also references a secret via
        // {env:...}. The JsonError message embeds the resolved text; the
        // diagnostics registry must strip the JSONC input section.
        process.env.TEST_CONFIG_SECRET = "sk-super-secret-value"
        await writeBrokenEmailFragment(
          '{ "email": { "smtp": { "host": "smtp.example.com", "password": "{env:TEST_CONFIG_SECRET}" } ',
        )
        await Config.reload("global")

        const issues = await Config.diagnostics()
        const emailIssue = issues.find((issue) => issue.path.endsWith("110-email.jsonc"))
        expect(emailIssue).toBeDefined()
        expect(emailIssue!.error).not.toContain("sk-super-secret-value")
        expect(emailIssue!.error).not.toContain("--- JSONC Input ---")
        // Parser error detail is preserved for the user to fix the file.
        expect(emailIssue!.error).toContain("CloseBraceExpected")
      },
    })
  })
})
