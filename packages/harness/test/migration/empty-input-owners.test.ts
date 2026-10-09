import { expect, test } from "bun:test"
import { migrationFixture } from "./fixture"
import { migrations as sessions } from "../../src/session/migration"
import { migrations as scopes } from "../../src/scope/migration"
import { workspaceMigrations } from "../../src/workspace/migration"
import { environmentMigrations } from "../../src/environment/migration"
import { Storage } from "../../src/storage/storage"

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
