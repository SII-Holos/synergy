import { expect, test } from "bun:test"
import { migrationFixture } from "./fixture"
import { migrations as sessions } from "../../src/session/migration"
import { migrations as scopes } from "../../src/scope/migration"
import { workspaceMigrations } from "../../src/workspace/migration"
import { environmentMigrations } from "../../src/environment/migration"
import { migrations as storage } from "../../src/storage/migration"
import { UsageMigration } from "../../src/usage/migration"
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

test("rollout migration still retires stale statistics without Session records", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const migration = sessions.find((item) => item.id === "20260907-session-rollout-evidence")!
    await Storage.write(["stats", "snapshot"], { obsolete: true })
    MigrationRegistry.register("session", [{ ...migration, dependsOn: undefined }])
    await runMigrations({ output: "silent" })
    expect(await Storage.list(["stats"])).toEqual([])
  })
})

test("Link retirement still removes a permission rule without retained targets", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const migration = storage.find((item) => item.id === "20260929-retire-synergy-link")!
    const retained = { permission: "shell", pattern: "*", action: "ask", scope: "user" }
    await Storage.write(
      ["permission-rules"],
      [{ permission: "shell_remote_execute", pattern: "*", action: "allow", scope: "user" }, retained],
    )
    MigrationRegistry.register("storage", [migration])
    await runMigrations({ output: "silent" })
    expect(await Storage.read<Array<typeof retained>>(["permission-rules"])).toEqual([retained])
  })
})

test("empty Workspace migration does not create a local Host identity", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const migration = workspaceMigrations.find((item) => item.id === "20261003-persistent-volume-identity")!
    const identity = Bun.file(`${fixture.host.root}/workspace-host`)
    expect(await identity.exists()).toBe(false)
    await migration.up(() => {})
    expect(await identity.exists()).toBe(false)
  })
})

for (const migration of [
  ...sessions,
  ...scopes,
  ...workspaceMigrations,
  ...environmentMigrations,
  ...storage,
  UsageMigration.lineageMigration,
]) {
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
