import fs from "node:fs/promises"
import { expect, test } from "bun:test"
import path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { migrationFixture } from "./fixture"
import { migrations as configMigrations } from "../../src/config/migration"
import { migrations as sessionMigrations } from "../../src/session/migration"
import { Storage } from "../../src/storage/storage"
import { Global } from "../../src/global"
import { MigrationRegistry } from "../../src/migration/registry"
import { runMigrations, upgradeImportedConfig } from "../../src/migration"
import { PermissionNext } from "../../src/permission/next"

function migration(domain: "config" | "session") {
  const entries = domain === "config" ? configMigrations : sessionMigrations
  const result = entries.find((entry) => entry.id === `20261002-${domain}-primary-agent-identities`)
  expect(result).toBeDefined()
  return result!
}

test("import upgrades follow registered ownership changes before admission", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(() => {
    const input = { executor: "fixture-previous" }
    expect(upgradeImportedConfig(input)).toEqual(input)
    MigrationRegistry.register("fixture-owner", [
      {
        id: "20261002-fixture-owner",
        description: "Fixture ownership",
        async up() {},
        upgradeConfig(config) {
          if (config.executor === "fixture-previous") config.executor = "fixture-current"
        },
      },
    ])
    expect(upgradeImportedConfig(input)).toEqual({ executor: "fixture-current" })
    MigrationRegistry.unregister("fixture-owner")
    expect(upgradeImportedConfig(input)).toEqual(input)
  })
})

test("configuration upgrade preserves models, custom agents, comments and prompt bodies", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const file = path.join(Global.Path.config, "synergy.d", "60-agents.jsonc")
    const markdown = path.join(Global.Path.config, "agent", "synergy-max.md")
    const commandMarkdown = path.join(Global.Path.config, "command", "synergy.md")
    await Bun.write(
      file,
      `// keep this comment\n{"default_agent":"synergy-max","agent":{"synergy":{"model":"fixture/a"},"synergy-flash":{"visibleTo":["synergy","synergy-max","custom"],"prompt":"synergy-max stays in text"},"custom":{"permission":{"task":{"synergy-max":"allow"}}}},"command":{"check":{"agent":"synergy-max","template":"synergy send"}}}`,
    )
    await Bun.write(
      markdown,
      "---\nvisibleTo: [synergy, synergy-max]\nmodel: fixture/b\n---\nDo not rewrite synergy-max in this prompt.\n",
    )
    await Bun.write(commandMarkdown, "---\nname: synergy\nagent: synergy-max\n---\nRun synergy send.\n")
    const upgrade = migration("config")
    MigrationRegistry.register("config", [upgrade])
    await upgrade.up(() => {})
    const text = await Bun.file(file).text()
    const config = parseJsonc(text)
    expect(text).toContain("// keep this comment")
    expect(config).toMatchObject({
      default_agent: "forge",
      agent: {
        atlas: { model: "fixture/a" },
        pico: { visibleTo: ["atlas", "forge", "custom"], prompt: "synergy-max stays in text" },
        custom: { permission: { task: { forge: "allow" } } },
      },
      command: { check: { agent: "forge", template: "synergy send" } },
    })
    expect(Object.keys(config.agent)).toEqual(["atlas", "pico", "custom"])
    expect(await Bun.file(markdown).exists()).toBe(false)
    expect(await Bun.file(commandMarkdown).text()).toContain("name: synergy\nagent: forge\n")
    expect(await Bun.file(path.join(Global.Path.config, "agent", "forge.md")).text()).toContain(
      "Do not rewrite synergy-max in this prompt.\n",
    )
    await upgrade.up(() => {})
    expect(await Bun.file(file).text()).toBe(text)
  })
})

test("renaming delegation permissions preserves rule precedence and attached JSONC comments", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const file = path.join(Global.Path.config, "synergy.d", "65-permissions.jsonc")
    await Bun.write(file, '{"permission":{"task":{"synergy-max" /* keep rule comment */: "deny", "*": "allow"}}}')
    const upgrade = migration("config")
    MigrationRegistry.register("config", [upgrade])
    await upgrade.up(() => {})
    const text = await Bun.file(file).text()
    const config = parseJsonc(text)
    expect(PermissionNext.evaluate("task", "forge", PermissionNext.fromConfig(config.permission)).action).toBe("allow")
    expect(text).toContain("/* keep rule comment */")
  })
})

test("Session upgrade changes only executable identities, including queued input", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const root = ["sessions", "scope-fixture", "session-fixture"]
    await Storage.write([...root, "info"], {
      agentOverride: "synergy-max",
      cortex: { agent: "synergy-flash" },
      permission: [
        { permission: "task", pattern: "synergy-max", action: "deny" },
        { permission: "task", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "synergy-max", action: "ask" },
      ],
      title: "synergy-max",
      unknown: { agent: "synergy" },
    })
    await Storage.write([...root, "messages", "message-fixture", "info"], {
      role: "assistant",
      agent: "synergy-max",
      mode: "synergy-max",
      metadata: { agent: "synergy" },
    })
    await Storage.write([...root, "messages", "message-fixture", "parts", "part-fixture"], {
      type: "text",
      text: "synergy-max",
    })
    await Storage.write([...root, "inbox", "input-fixture"], {
      message: { agent: "synergy-flash", parts: [{ type: "text", text: "synergy" }] },
      input: { agent: "synergy-flash" },
    })
    await Storage.write([...root, "inbox-removed", "removed-fixture"], {
      item: { message: { agent: "synergy" }, input: { agent: "synergy-max" } },
      restoredAt: 1,
    })
    const upgrade = migration("session")
    await upgrade.up(() => {})
    expect(await Storage.read<Record<string, unknown>>([...root, "info"])).toEqual({
      agentOverride: "forge",
      cortex: { agent: "pico" },
      permission: [
        { permission: "task", pattern: "forge", action: "deny" },
        { permission: "task", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "synergy-max", action: "ask" },
      ],
      title: "synergy-max",
      unknown: { agent: "synergy" },
    })
    expect(await Storage.read<Record<string, unknown>>([...root, "messages", "message-fixture", "info"])).toEqual({
      role: "assistant",
      agent: "forge",
      mode: "forge",
      metadata: { agent: "synergy" },
    })
    expect(await Storage.read<Record<string, unknown>>([...root, "inbox", "input-fixture"])).toEqual({
      message: { agent: "pico", parts: [{ type: "text", text: "synergy" }] },
      input: { agent: "pico" },
    })
    expect(await Storage.read<Record<string, unknown>>([...root, "inbox-removed", "removed-fixture"])).toEqual({
      item: { message: { agent: "atlas" }, input: { agent: "forge" } },
      restoredAt: 1,
    })
    expect(
      await Storage.read<Record<string, unknown>>([...root, "messages", "message-fixture", "parts", "part-fixture"]),
    ).toEqual({ type: "text", text: "synergy-max" })
    await upgrade.up(() => {})
    expect(await Storage.read<Record<string, unknown>>([...root, "info"])).toMatchObject({ agentOverride: "forge" })
  })
})

test("a failed upgrade gets no completion receipt and retries without changing history", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    await fs.mkdir(path.join(fixture.host.root, "data"), { recursive: true })
    const upgrade = migration("session")
    let fail = true
    MigrationRegistry.register("rename-retry", [
      {
        ...upgrade,
        async up(progress) {
          await upgrade.up(progress)
          if (fail) {
            fail = false
            throw new Error("fixture interruption")
          }
        },
      },
    ])
    const key = ["sessions", "scope-fixture", "session-fixture", "info"]
    await Storage.write(key, { agentOverride: "synergy", title: "synergy" })
    await expect(runMigrations({ targetDomain: "rename-retry", output: "silent" })).rejects.toThrow(
      "fixture interruption",
    )
    await runMigrations({ targetDomain: "rename-retry", output: "silent" })
    expect(await Storage.read<Record<string, unknown>>(key)).toEqual({ agentOverride: "atlas", title: "synergy" })
    expect((await runMigrations({ targetDomain: "rename-retry", output: "silent" })).completed).toBe(0)
  })
})
