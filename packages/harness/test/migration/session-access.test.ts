import { expect, spyOn, test } from "bun:test"
import { migrationFixture } from "./fixture"
import { MigrationRegistry } from "../../src/migration/registry"
import { upgradeSessionRecords } from "../../src/migration"
import { Storage } from "../../src/storage/storage"

test("metadata predicates see preceding dependency upgrades in the same access", async () => {
  await using runtime = await migrationFixture()
  await runtime.run(async () => {
    const owner = { scopeID: "home", sessionID: "dependent-session" }
    const key = ["sessions", owner.scopeID, owner.sessionID, "info"]
    MigrationRegistry.register("access-dependency", [
      {
        id: "20261017-first",
        description: "Introduce the next metadata input",
        execution: "session",
        onAccess: (record) => record.old !== undefined,
        async up() {},
        async upSession() {
          await Storage.write(key, { middle: true })
        },
      },
      {
        id: "20261017-second",
        description: "Consume an input introduced by the previous migration",
        execution: "session",
        dependsOn: ["20261017-first"],
        onAccess: (record) => record.middle === true,
        async up() {},
        async upSession() {
          await Storage.write(key, { current: true })
        },
      },
    ])
    await Storage.write(key, { old: true })
    await upgradeSessionRecords([owner])
    expect(await Storage.read<Record<string, unknown>>(key)).toEqual({ current: true })
  })
})

test("metadata access avoids writing receipts for absent owner input and upgrades it when it appears", async () => {
  await using runtime = await migrationFixture()
  await runtime.run(async () => {
    let runs = 0
    MigrationRegistry.register("access-fixture", [
      {
        id: "20261017-metadata-input",
        description: "Upgrade only metadata containing the retained owner field",
        execution: "session",
        onAccess: (record) => record.legacy !== undefined,
        scope: "session",
        async up() {},
        async upSession(owner) {
          runs++
          await Storage.update<Record<string, unknown>>(
            ["sessions", owner.scopeID, owner.sessionID, "info"],
            (record) => {
              record.current = record.legacy
              delete record.legacy
            },
          )
        },
      },
    ])
    const owners = Array.from({ length: 300 }, (_, index) => ({ scopeID: "home", sessionID: `session-${index}` }))
    await Storage.transaction((tx) =>
      tx.writeMany(
        owners.map((owner) => ({
          key: ["sessions", owner.scopeID, owner.sessionID, "info"],
          value: { id: owner.sessionID },
        })),
      ),
    )
    {
      using transactions = spyOn(Storage, "transaction")
      await upgradeSessionRecords(owners)
      expect(transactions.mock.calls.length).toBe(0)
      expect(runs).toBe(0)
    }
    const owner = owners[0]!
    const key = ["sessions", owner.scopeID, owner.sessionID, "info"]
    const receipt = [
      "sessions",
      owner.scopeID,
      owner.sessionID,
      "migrations",
      "access-fixture",
      "20261017-metadata-input",
    ]
    expect((await Storage.readMany([receipt]))[0]).toBeUndefined()
    await Storage.write(key, { id: owner.sessionID, legacy: "retained", unrelated: 42 })
    await Promise.all([upgradeSessionRecords([owner, owner]), upgradeSessionRecords([owner])])
    expect(runs).toBe(1)
    expect(await Storage.read<Record<string, unknown>>(key)).toEqual({
      id: owner.sessionID,
      current: "retained",
      unrelated: 42,
    })
    expect((await Storage.readMany([receipt]))[0]).toBeDefined()
  })
})
