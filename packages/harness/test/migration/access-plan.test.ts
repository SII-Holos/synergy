import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { migrationFixture } from "./fixture"
import { MigrationRegistry } from "../../src/migration/registry"
import { MigrationPlan } from "../../src/migration/plan"
import { prepareSessionMigrations, upgradeSessionRecords } from "../../src/migration"
import type { Migration } from "../../src/migration/types"
import { Storage } from "../../src/storage/storage"
import { StorageConflictError } from "../../src/storage/errors"
import { TransactionalStore } from "../../src/storage/transactional-store"
import { storageTestOptions } from "../support/storage-backends"

const owner = { scopeID: "home", sessionID: "selected" }
const info = (selected: typeof owner) => ["sessions", selected.scopeID, selected.sessionID, "info"]
const receipt = (selected: typeof owner, id = "first") => [
  "sessions",
  selected.scopeID,
  selected.sessionID,
  "migrations",
  "access-plan",
  id,
]

function migration(id: string, calls: string[], dependsOn?: string[]): Migration {
  return {
    id,
    description: id,
    execution: "session",
    scope: "session",
    onAccess: true,
    dependsOn,
    async up() {
      throw new Error("Access preparation must not execute startup work")
    },
    async upSession(selected) {
      calls.push(`${selected.scopeID}/${selected.sessionID}/${id}`)
      await Storage.write(["prepared", selected.scopeID, selected.sessionID, id], { current: true })
    },
  }
}

async function seed(selected = owner) {
  await Storage.write(info(selected), { id: selected.sessionID })
}

test("unchanged registrations sort one access plan while repeated owner reads retain their receipts", async () => {
  await using runtime = await migrationFixture()
  await runtime.run(async () => {
    const calls: string[] = []
    MigrationRegistry.register("access-plan", [
      migration("third", calls, ["second"]),
      migration("first", calls),
      migration("second", calls, ["first"]),
    ])
    await seed()
    const ordered = MigrationPlan.ordered
    const builds: number[] = []
    using observed = spyOn(MigrationPlan, "ordered").mockImplementation((domains) => {
      builds.push([...domains.values()].reduce((count, entries) => count + entries.length, 0))
      return ordered(domains)
    })
    for (let round = 0; round < 4; round++) {
      await prepareSessionMigrations(owner)
      await upgradeSessionRecords([owner])
    }
    expect(calls).toEqual(["home/selected/first", "home/selected/second", "home/selected/third"])
    expect(
      (await Storage.readMany([receipt(owner, "first"), receipt(owner, "second"), receipt(owner, "third")])).every(
        Boolean,
      ),
    ).toBe(true)
    expect(builds).toEqual([3])
  })
})

test("a reused plan still observes receipt changes, transaction rollback, Scope and Store selection", async () => {
  await using runtime = await migrationFixture()
  await runtime.run(async () => {
    const otherStore = await TransactionalStore.open(
      storageTestOptions({
        namespace: `migration-access-second-${Bun.hash(runtime.host.root).toString(16)}`,
        filename: path.join(runtime.host.root, "second.sqlite"),
      }),
    )
    try {
      const calls: string[] = []
      MigrationRegistry.register("access-plan", [migration("first", calls)])
      await seed()
      await prepareSessionMigrations(owner)
      const rollback = new Error("Rollback the original receipt deletion")
      let outcome: unknown
      try {
        await Storage.transaction(async () => {
          await Storage.remove(receipt(owner))
          let blocked: unknown
          try {
            await prepareSessionMigrations(owner)
          } catch (error) {
            blocked = error
          }
          expect(blocked).toBeInstanceOf(StorageConflictError)
          throw rollback
        })
      } catch (error) {
        outcome = error
      }
      expect(outcome).toBe(rollback)
      expect((await Storage.readMany([receipt(owner)]))[0]).toBeDefined()
      await prepareSessionMigrations(owner)
      expect(calls).toHaveLength(1)
      await Storage.remove(receipt(owner))
      await prepareSessionMigrations(owner)
      const scoped = { ...owner, scopeID: "other" }
      await seed(scoped)
      await prepareSessionMigrations(scoped)
      await Storage.provide(
        { store: otherStore, artifactDirectory: path.join(runtime.host.root, "second-artifacts") },
        async () => {
          await seed()
          expect((await Storage.readMany([receipt(owner)]))[0]).toBeUndefined()
          await prepareSessionMigrations(owner)
          expect((await Storage.readMany([receipt(owner)]))[0]).toBeDefined()
        },
      )
      expect(calls).toEqual([
        "home/selected/first",
        "home/selected/first",
        "other/selected/first",
        "home/selected/first",
      ])
    } finally {
      await otherStore.close()
    }
  })
})

test("equal registration generations remain isolated between Runtime instances and closure", async () => {
  await using first = await migrationFixture()
  await using second = await migrationFixture()
  const a: string[] = [],
    b: string[] = []
  first.run(() => MigrationRegistry.register("access-plan", [migration("first", a)]))
  second.run(() => MigrationRegistry.register("access-plan", [migration("first", b)]))
  expect(first.run(() => MigrationRegistry.generation())).toBe(second.run(() => MigrationRegistry.generation()))
  await first.run(async () => {
    await seed()
    await prepareSessionMigrations(owner)
  })
  await second.run(async () => {
    await seed()
    await prepareSessionMigrations(owner)
  })
  expect(a).toEqual(["home/selected/first"])
  expect(b).toEqual(["home/selected/first"])
  await first.close()
  await second.run(async () => {
    const next = { ...owner, sessionID: "later" }
    await seed(next)
    await prepareSessionMigrations(next)
  })
  expect(a).toHaveLength(1)
  expect(b).toEqual(["home/selected/first", "home/later/first"])
})

test("registration, removal and configuration exclusion invalidate the pure plan before the next owner", async () => {
  await using runtime = await migrationFixture()
  await runtime.run(async () => {
    const calls: string[] = []
    let sequence = 0
    const next = async () => {
      const selected = { ...owner, sessionID: String(sequence++) }
      await seed(selected)
      const before = calls.length
      await prepareSessionMigrations(selected)
      return calls.slice(before).map((entry) => entry.split("/").at(-1))
    }
    MigrationRegistry.register("access-plan", [migration("first", calls)])
    expect(await next()).toEqual(["first"])
    MigrationRegistry.register("additional", [migration("second", calls, ["access-plan/first"])])
    expect(await next()).toEqual(["first", "second"])
    MigrationRegistry.unregister("additional")
    expect(await next()).toEqual(["first"])
    MigrationRegistry.register("configuration", [{ ...migration("file", calls), configuration: "files" }])
    expect(await next()).toEqual(["first", "file"])
    MigrationRegistry.excludeFileConfiguration()
    expect(await next()).toEqual(["first"])
    MigrationRegistry.register("invalid", [migration("bad", calls, ["missing/required"])])
    let missing: unknown
    try {
      await next()
    } catch (error) {
      missing = error
    }
    expect(missing).toBeInstanceOf(Error)
    expect((missing as Error).message).toContain("missing dependency")
    MigrationRegistry.register("missing", [migration("required", calls)])
    expect(await next()).toEqual(["first", "required", "bad"])
  })
})

test("cached registration structure never caches on-access conditions or absent completion receipts", async () => {
  await using runtime = await migrationFixture()
  await runtime.run(async () => {
    let enabled = false
    let calls = 0
    MigrationRegistry.register("access-plan", [
      {
        id: "first",
        description: "First",
        execution: "session",
        scope: "session",
        onAccess: (record) => enabled && record.legacy === true,
        async up() {},
        async upSession(selected) {
          calls++
          await Storage.write(info(selected), { current: true })
        },
      },
    ])
    await Storage.write(info(owner), { legacy: true })
    await upgradeSessionRecords([owner])
    expect(calls).toBe(0)
    expect((await Storage.readMany([receipt(owner)]))[0]).toBeUndefined()
    enabled = true
    await upgradeSessionRecords([owner])
    expect(calls).toBe(1)
    expect(await Storage.read(info(owner))).toEqual({ current: true })
    await Storage.remove(receipt(owner))
    await Storage.write(info(owner), { legacy: true })
    enabled = false
    await upgradeSessionRecords([owner])
    expect(calls).toBe(1)
    expect((await Storage.readMany([receipt(owner)]))[0]).toBeUndefined()
    enabled = true
    await upgradeSessionRecords([owner])
    expect(calls).toBe(2)
  })
})

test("callback receivers cannot modify the retained plan for a later owner", async () => {
  await using runtime = await migrationFixture()
  await runtime.run(async () => {
    const seen: Array<{ description: string; dependsOn: string[]; emptyInput: string[][] }> = []
    MigrationRegistry.register("access-plan", [
      {
        id: "first",
        description: "Original",
        execution: "session",
        dependsOn: [],
        emptyInput: [["legacy"]],
        async up() {},
        async upSession() {
          seen.push({
            description: this.description,
            dependsOn: [...this.dependsOn!],
            emptyInput: this.emptyInput!.map((prefix) => [...prefix]),
          })
          this.description = "Changed by this invocation"
          this.dependsOn!.push("missing")
          this.emptyInput![0]!.push("changed")
        },
      },
    ])
    for (const sessionID of ["one", "two"]) {
      const selected = { ...owner, sessionID }
      await seed(selected)
      await prepareSessionMigrations(selected)
    }
    expect(seen).toEqual([
      { description: "Original", dependsOn: [], emptyInput: [["legacy"]] },
      { description: "Original", dependsOn: [], emptyInput: [["legacy"]] },
    ])
    expect(MigrationRegistry.list().get("access-plan")![0]!.description).toBe("Original")
  })
})
