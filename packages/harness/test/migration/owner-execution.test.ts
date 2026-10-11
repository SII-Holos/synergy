import { expect, test } from "bun:test"
import { migrationFixture } from "./fixture"
import { MigrationRegistry } from "../../src/migration/registry"
import { prepareOwnerMigrations, runMigrations } from "../../src/migration"
import { Storage } from "../../src/storage/storage"

test("owner upgrades stay off startup and retry in dependency order for sessions and operations", async () => {
  await using runtime = await migrationFixture()
  await runtime.run(async () => {
    const calls: string[] = []
    let fail = true
    MigrationRegistry.register(
      "fixture",
      ["first", "second"].map((id) => ({
        id,
        description: id,
        scope: "session" as const,
        execution: "owner" as const,
        dependsOn: id === "second" ? ["first"] : [],
        async up() {
          throw new Error("startup must not enumerate history")
        },
        async upOwner(owner) {
          calls.push(`${owner.kind}:${id}`)
          if (id === "second" && fail) {
            fail = false
            throw new Error("interrupted")
          }
        },
      })),
    )
    await Storage.write(["sessions", "home", "selected", "info"], { id: "selected" })
    await Storage.write(["operations", "home", "selected", "rollout", "journal", "head"], {
      allocated: 0,
      committed: 0,
    })
    await Storage.write(["compat_import", "cohorts", "fixture", "first"], {
      domain: "fixture",
      id: "first",
      residentComplete: false,
    })
    await runMigrations({ output: "silent" })
    expect(await Storage.readMany([["compat_import", "cohorts", "fixture", "first"]])).toEqual([undefined])
    expect(calls).toEqual([])
    const session = { kind: "session" as const, scopeID: "home", sessionID: "selected" }
    await expect(prepareOwnerMigrations(session)).rejects.toThrow("interrupted")
    await Promise.all([
      prepareOwnerMigrations(session),
      prepareOwnerMigrations({ scopeID: session.scopeID, sessionID: session.sessionID, kind: session.kind }),
    ])
    const operation = { kind: "operation" as const, scopeID: "home", operationID: "selected" }
    await prepareOwnerMigrations(operation)
    await prepareOwnerMigrations(operation)
    await prepareOwnerMigrations({ ...session, sessionID: "missing" })
    expect(calls).toEqual(["session:first", "session:second", "session:second", "operation:first", "operation:second"])
  })
})
