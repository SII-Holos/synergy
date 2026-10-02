import { expect, test } from "bun:test"
import { compositionFixture } from "../support/composition"
import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { upgradeImportedConfig, upgradeImportedRecord } from "@ericsanchezok/synergy-harness/migration"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"

test("full composition upgrades owned execution references without rewriting historical content", async () => {
  await using fixture = await compositionFixture()
  await fixture.run(async () => {
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
          blueprint: { defaultAgent: "synergy-max", auditAgent: "synergy" },
          content: { agent: "synergy-max" },
          version: 7,
        },
        after: {
          blueprint: { defaultAgent: "forge", auditAgent: "atlas" },
          content: { agent: "synergy-max" },
          version: 7,
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
    for (const { key, before, after } of records) {
      const imported = upgradeImportedRecord(key, before)
      expect(imported).toEqual(after)
      expect(upgradeImportedRecord(key, imported)).toEqual(after)
      await Storage.write(key, before)
    }
    await Storage.write(["notes", "home", "_index"], [{ blueprint: { defaultAgent: "synergy-max" } }])
    const migrations = [...MigrationRegistry.list().values()]
      .flat()
      .filter((migration) => migration.id.endsWith("primary-agent-identities"))
    expect(migrations.map((migration) => migration.id).sort()).toEqual([
      "20261002-agenda-primary-agent-identities",
      "20261002-blueprint-primary-agent-identities",
      "20261002-channel-primary-agent-identities",
      "20261002-config-primary-agent-identities",
      "20261002-note-primary-agent-identities",
      "20261002-session-primary-agent-identities",
      "20261002-workflow-session-primary-agent-identities",
    ])
    for (const migration of migrations) await migration.up(() => {})
    for (const { key, after } of records) expect(await Storage.read<Record<string, unknown>>(key)).toEqual(after)
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
        clarus: { accounts: { team: { agent: "forge" } } },
        github: { accounts: { team: { agent: "pico" } } },
      },
      holos: { agentId: "synergy" },
    })
    expect(config.default_agent).toBe("synergy")
  })
})
