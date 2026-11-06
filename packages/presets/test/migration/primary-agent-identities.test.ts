import { expect, test } from "bun:test"
import { compositionFixture } from "../support/composition"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { upgradeImportedConfig, upgradeImportedRecord } from "@ericsanchezok/synergy-harness/migration"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"

test("full composition upgrades owned execution references without rewriting historical content", async () => {
  await using fixture = await compositionFixture()
  await fixture.run(async () => {
    const note = {
      id: "note_fixture",
      title: "Historical Blueprint",
      kind: "blueprint",
      pinned: false,
      global: true,
      archived: false,
      tags: [],
      content: {
        type: "doc",
        agent: "synergy-max",
        content: [
          {
            type: "paragraph",
            attrs: { blockId: "blk_fixture" },
            content: [{ type: "text", text: "synergy-max" }],
          },
        ],
      },
      version: 7,
      time: { created: 1, updated: 2 },
    }
    const records = [
      {
        key: ["sessions", "home", "ses_fixture", "info"],
        before: {
          agentOverride: "synergy-max",
          workflow: { kind: "lightloop", executionAgent: "synergy-max", reviewAgent: "synergy-flash" },
          cortex: { agent: "synergy" },
          title: "synergy-max",
        },
        after: {
          agentOverride: "forge",
          workflow: { kind: "lightloop", executionAgent: "forge", reviewAgent: "pico" },
          cortex: { agent: "atlas" },
          title: "synergy-max",
        },
      },
      {
        key: ["blueprint_loops", "home", "loop_fixture"],
        before: { executionAgent: "synergy-max", auditAgent: "synergy-flash", description: "synergy-max" },
        after: { executionAgent: "forge", auditAgent: "pico", description: "synergy-max" },
      },
      {
        key: ["notes", "home", "note_fixture"],
        before: {
          ...note,
          blueprint: { defaultAgent: "synergy-max", auditAgent: "synergy" },
        },
        after: {
          ...note,
          blueprint: { defaultAgent: "forge", auditAgent: "atlas" },
        },
      },
      {
        key: ["agenda", "items", "home", "item_fixture"],
        before: {
          agent: "synergy-flash",
          task: { agent: "synergy" },
          triggers: [
            { type: "session", agent: "synergy-max" },
            { type: "every", interval: "1h" },
          ],
          prompt: "synergy",
        },
        after: {
          agent: "pico",
          task: { agent: "atlas" },
          triggers: [
            { type: "session", agent: "forge" },
            { type: "every", interval: "1h" },
          ],
          prompt: "synergy",
        },
      },
    ]
    const retained = [
      { ...note, id: "note_plain", kind: "note" },
      { ...note, id: "note_future", kind: "future-owner" },
    ].map((value) => ({
      ...value,
      blueprint: { defaultAgent: "synergy-max", auditAgent: "synergy" },
    }))
    for (const before of retained) {
      const key = ["notes", "home", before.id]
      expect(upgradeImportedRecord(key, before)).toEqual(before)
      await Storage.write(key, before)
    }
    for (const { key, before, after } of records) {
      const imported = upgradeImportedRecord(key, before)
      expect(imported).toEqual(after)
      expect(upgradeImportedRecord(key, imported)).toEqual(after)
      await Storage.write(key, before)
    }
    await Storage.write(["notes", "home", "_index"], [{ blueprint: { defaultAgent: "synergy-max" } }])
    const migrations = [...MigrationRegistry.list().values()]
      .flat()
      .filter(
        (migration) =>
          migration.id.endsWith("primary-agent-identities") ||
          migration.id === "20261012-blueprint-note-owner" ||
          migration.id === "20261012-light-loop-session-owner",
      )
    for (const { up } of migrations) await up(() => {})
    for (const { key, after } of records) expect(await Storage.read<Record<string, unknown>>(key)).toEqual(after)
    for (const before of retained)
      expect(await Storage.read<Record<string, unknown>>(["notes", "home", before.id])).toEqual(before)
    expect((await Storage.readMany([["notes", "home", "_index"]]))[0]).toBeUndefined()
    const config = {
      default_agent: "synergy",
      channel: {
        clarus: { accounts: { team: { agent: "synergy-max" } } },
        github: { accounts: { team: { agent: "synergy-flash" } } },
      },
      holos: { agentId: "synergy" },
    }
    expect(upgradeImportedConfig(config)).toEqual({
      default_agent: "atlas",
      channel: {
        github: { accounts: { team: { agent: "pico" } } },
      },
    })
    expect(config.default_agent).toBe("synergy")
  })
})
