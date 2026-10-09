import { expect, test } from "bun:test"
import { migrationFixture } from "./fixture"
import { migrations as sessions } from "../../src/session/migration"
import { migrations as scopes } from "../../src/scope/migration"
import { workspaceMigrations } from "../../src/workspace/migration"
import { environmentMigrations } from "../../src/environment/migration"
import { Storage } from "../../src/storage/storage"
import { MigrationRegistry } from "../../src/migration/registry"
import { runMigrations } from "../../src/migration"

test("a navigation migration still clears a stale home index without Sessions", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const migration = sessions.find((item) => item.id === "20260624-session-home-nav-rebuild")!
    const key = ["session_nav_v2", "home"]
    await Storage.write(key, { version: 1, scopeID: "home", updatedAt: 1, entries: [{ id: "stale" }] })
    MigrationRegistry.register("session", [migration])
    await runMigrations({ output: "silent" })
    expect((await Storage.read<{ entries: unknown[] }>(key)).entries).toEqual([])
  })
})

for (const migration of [...sessions, ...scopes, ...workspaceMigrations, ...environmentMigrations]) {
  if (!migration.emptyInput) continue
  test(`${migration.id} has no persistent effects without its declared input`, async () => {
    await using fixture = await migrationFixture()
    await fixture.run(async () => {
      const before = await Storage.current().store.snapshot(async (tx) => Array.fromAsync(tx.exportEntries()))
      await migration.up(() => {})
      const after = await Storage.current().store.snapshot(async (tx) => Array.fromAsync(tx.exportEntries()))
      expect(after).toEqual(before)
    })
  })
}
