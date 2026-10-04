import { expect, test } from "bun:test"
import path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { migrationFixture } from "./fixture"
import { migrations as configMigrations } from "../../src/config/migration"
import { migrations as sessionMigrations } from "../../src/session/migration"
import { Storage } from "../../src/storage/storage"
import { Global } from "../../src/global"
import { MigrationRegistry } from "../../src/migration/registry"
import { upgradeImportedConfig } from "../../src/migration"
import { PermissionNext } from "../../src/permission/next"
import { ConfigReferenceMigration } from "../../src/config/reference-migration"
import { SessionHistoryDisplay } from "../../src/session/history-display"
import type { MessageV2 } from "../../src/session/message-v2"

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
      `// keep this comment\n{"default_agent":"synergy-max","agent":{"synergy":{"model":"fixture/a"},"synergy-flash":{"visibleTo":["synergy","synergy-max","custom"],"prompt":"synergy-max stays in text"},"custom":{"permission":{"task":{"synergy-max":"allow"}}}},"permission":{"task":{"synergy-max" /* keep rule comment */: "deny","*":"allow"}},"command":{"check":{"agent":"synergy-max","template":"synergy send"}}}`,
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
    expect(text).toContain("/* keep rule comment */")
    expect(config).toMatchObject({
      default_agent: "forge",
      agent: {
        atlas: { model: "fixture/a" },
        pico: { visibleTo: ["atlas", "forge", "custom"], prompt: "synergy-max stays in text" },
        custom: { permission: { task: { forge: "allow" } } },
      },
      permission: { task: { forge: "deny", "*": "allow" } },
      command: { check: { agent: "forge", template: "synergy send" } },
    })
    expect(PermissionNext.evaluate("task", "forge", PermissionNext.fromConfig(config.permission)).action).toBe("allow")
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

test("configuration identity collisions preserve every definition and permission", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    MigrationRegistry.register("config", [migration("config")])
    for (const input of [
      { agent: { synergy: { model: "fixture/a" }, atlas: { model: "fixture/b" } } },
      { agent: { atlas: { model: "fixture/b" }, synergy: { model: "fixture/a" } } },
      { permission: { task: { synergy: "deny", atlas: "allow" } } },
    ]) {
      const file = path.join(Global.Path.config, "synergy.d", "60-agents.jsonc")
      const text = `// preserve conflicting definitions\n${JSON.stringify(input)}`
      await Bun.write(file, text)
      await expect(ConfigReferenceMigration.file(file)).rejects.toThrow("both identities exist")
      expect(await Bun.file(file).text()).toBe(text)
      expect(() => upgradeImportedConfig(input)).toThrow("both identities exist")
      expect(JSON.stringify(input)).toBe(text.split("\n")[1])
    }
  })
})

test("Markdown identity collisions leave both original files untouched", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const directory = path.join(Global.Path.config, "agent")
    const oldFile = path.join(directory, "synergy.md")
    const currentFile = path.join(directory, "atlas.md")
    const oldText = "---\nmodel: fixture/old\n---\nOriginal general instructions.\n"
    const currentText = "---\nmodel: fixture/custom\n---\nIndependent custom instructions.\n"
    await Bun.write(oldFile, oldText)
    await Bun.write(currentFile, currentText)
    await expect(ConfigReferenceMigration.directory(Global.Path.config)).rejects.toThrow("both identities exist")
    expect(await Bun.file(oldFile).text()).toBe(oldText)
    expect(await Bun.file(currentFile).text()).toBe(currentText)
  })
})

test("Session identity upgrades refresh already-prepared presentation headers", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const scopeID = "scope-display"
    const sessionID = "session-display"
    const info: MessageV2.User = {
      id: "message-display",
      sessionID,
      role: "user",
      agent: "synergy",
      time: { created: 1 },
      model: { providerID: "fixture", modelID: "model" },
      isRoot: true,
      visible: true,
    }
    const key = ["sessions", scopeID, sessionID, "messages", info.id, "info"]
    await Storage.write(key, info)
    await SessionHistoryDisplay.initialize(scopeID, sessionID)
    await SessionHistoryDisplay.messageWritten(scopeID, info)
    await migration("session").up(() => {})
    const current = await Storage.read<MessageV2.User>(key)
    await SessionHistoryDisplay.prepare(scopeID, sessionID, async () => [current])
    const expected = SessionHistoryDisplay.summarizeMessage(current)
    expect(current.agent).toBe("atlas")
    expect(await SessionHistoryDisplay.header(scopeID, sessionID, info.id)).toEqual(expected)
    const page = await SessionHistoryDisplay.timelinePage({ sessionID }, { hidden: new Set() }, scopeID)
    expect(page.total).toBe(1)
    expect(page.items).toEqual([expected])
    expect(await SessionHistoryDisplay.latestRoot(scopeID, sessionID, { hidden: new Set() })).toBe(info.id)
    const imported: Record<string, unknown> = {
      version: 1,
      ready: true,
      count: 1,
      generation: 4,
      cursor: "old",
      sourceGeneration: 4,
    }
    const displayUpgrade = sessionMigrations.find((entry) => entry.id === "20261001-session-display-index")!
    displayUpgrade.upgradeRecord!(["sessions", scopeID, sessionID, "display_state"], imported)
    expect(imported).toEqual({ version: 1, ready: false, count: 1, generation: 4 })
  })
})
