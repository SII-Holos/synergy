import { expect, spyOn, test } from "bun:test"
import { migrationFixture } from "./fixture"
import { MigrationRegistry } from "../../src/migration/registry"
import { prepareSessionMigrations, runMigrations } from "../../src/migration"
import { Storage } from "../../src/storage/storage"

const owner = { scopeID: "home", sessionID: "ses_selected" }

test("session execution defers history work, deduplicates preparation and persists dependency receipts", async () => {
  await using runtime = await migrationFixture()
  await runtime.run(async () => {
    const calls: string[] = []
    const gate = Promise.withResolvers<void>()
    MigrationRegistry.register("session-fixture", [
      {
        id: "first",
        description: "First",
        scope: "derived",
        execution: "session",
        async up() {
          throw new Error("must not scan global history")
        },
        async upSession(selected) {
          calls.push(`first:${selected.sessionID}`)
          await gate.promise
        },
      },
      {
        id: "second",
        description: "Second",
        scope: "derived",
        execution: "session",
        dependsOn: ["first"],
        async up() {
          throw new Error("must not scan global history")
        },
        async upSession(selected) {
          calls.push(`second:${selected.sessionID}`)
        },
      },
    ])
    await Storage.write(["sessions", owner.scopeID, owner.sessionID, "info"], { id: owner.sessionID })
    await runMigrations({ output: "silent" })
    expect(calls).toEqual([])
    const preparations = [prepareSessionMigrations(owner), prepareSessionMigrations(owner)]
    gate.resolve()
    await Promise.all(preparations)
    expect(calls).toEqual(["first:ses_selected", "second:ses_selected"])
    await prepareSessionMigrations(owner)
    expect(calls).toHaveLength(2)
    expect(
      await Storage.read(["sessions", "home", "ses_selected", "migrations", "session-fixture", "second"]),
    ).toMatchObject({ completed: expect.any(Number) })
  })
})

test("session preparation retries only failed steps and never prepares a missing owner", async () => {
  await using runtime = await migrationFixture()
  await runtime.run(async () => {
    let first = 0
    let second = 0
    MigrationRegistry.register("session-fixture", [
      {
        id: "first",
        description: "First",
        scope: "derived",
        execution: "session",
        async up() {},
        async upSession() {
          first++
        },
      },
      {
        id: "second",
        description: "Second",
        scope: "derived",
        execution: "session",
        dependsOn: ["first"],
        async up() {},
        async upSession() {
          if (++second === 1) throw new Error("interrupted")
        },
      },
    ])
    await runMigrations({ output: "silent" })
    await prepareSessionMigrations({ ...owner, sessionID: "ses_missing" })
    expect(first).toBe(0)
    await Storage.write(["sessions", owner.scopeID, owner.sessionID, "info"], { id: owner.sessionID })
    await expect(prepareSessionMigrations(owner)).rejects.toThrow("interrupted")
    await prepareSessionMigrations(owner)
    expect({ first, second }).toEqual({ first: 1, second: 2 })
  })
})

test("a prepared owner can be read inside a writer while an outside preparation is pending", async () => {
  await using runtime = await migrationFixture()
  await runtime.run(async () => {
    let migrations = 0
    MigrationRegistry.register("session-fixture", [
      {
        id: "prepared",
        description: "Prepared",
        scope: "derived",
        execution: "session",
        async up() {},
        async upSession() {
          migrations++
        },
      },
    ])
    const key = ["sessions", owner.scopeID, owner.sessionID, "info"]
    await Storage.write(key, { id: owner.sessionID })
    await prepareSessionMigrations(owner)
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const read = Storage.readMany
    let blocked = false
    using interception = spyOn(Storage, "readMany").mockImplementation(async (keys) => {
      if (!blocked && !Storage.inTransaction() && JSON.stringify(keys) === JSON.stringify([key])) {
        blocked = true
        entered.resolve()
        await release.promise
      }
      return read(keys)
    })
    const pending = prepareSessionMigrations(owner)
    await entered.promise
    let rescued = false
    const rescue = setTimeout(() => {
      rescued = true
      release.resolve()
    }, 2000)
    try {
      await Storage.transaction(async () => {
        await prepareSessionMigrations(owner)
        await Storage.write([...key.slice(0, -1), "result"], { prepared: true })
      })
      expect(rescued).toBe(false)
      expect(migrations).toBe(1)
    } finally {
      clearTimeout(rescue)
      release.resolve()
      await pending
    }
  })
})

test.each(["writer", "reader"] as const)("an unprepared owner does not start migration inside a %s", async (kind) => {
  await using runtime = await migrationFixture()
  await runtime.run(async () => {
    let calls = 0
    MigrationRegistry.register("session-fixture", [
      {
        id: "prepare",
        description: "Prepare",
        scope: "derived",
        execution: "session",
        async up() {},
        async upSession() {
          calls++
        },
      },
    ])
    await Storage.write(["sessions", owner.scopeID, owner.sessionID, "info"], { id: owner.sessionID })
    const transaction = kind === "writer" ? Storage.transaction : Storage.snapshot
    await expect(transaction(() => prepareSessionMigrations(owner))).rejects.toThrow("before opening a transaction")
    expect(calls).toBe(0)
    await prepareSessionMigrations(owner)
    await transaction(() => prepareSessionMigrations(owner))
    expect(calls).toBe(1)
  })
})
