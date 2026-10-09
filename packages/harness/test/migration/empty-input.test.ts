import { expect, spyOn, test } from "bun:test"
import { migrationFixture } from "./fixture"
import { MigrationRegistry } from "../../src/migration/registry"
import { getMigrationStatus, runMigrations } from "../../src/migration"
import { SessionCompat } from "../../src/session/compat-import"
import { Storage } from "../../src/storage/storage"
import type { Migration } from "../../src/migration/types"

function transform(id: string, calls: string[]): Migration {
  return {
    id,
    description: id,
    emptyInput: [["input"]],
    async up() {
      calls.push(id)
      for (const key of await Storage.list(["input"]))
        await Storage.update<{ version: number }>(key, (record) => record.version++)
    },
  }
}

test("empty transforms share a durable completion without running historical bodies", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const calls: string[] = []
    MigrationRegistry.register("empty-input", [transform("01", calls), transform("02", calls)])
    const writes = spyOn(Storage, "write")
    try {
      const result = await runMigrations({ output: "silent" })
      expect(result.completed).toBe(2)
      expect(calls).toEqual([])
      expect(writes.mock.calls.filter(([key]) => key.join("/") === "meta/migration/log-empty-input")).toHaveLength(1)
      expect((await getMigrationStatus())["empty-input"].pending).toEqual([])
    } finally {
      writes.mockRestore()
    }
  })
})

test("an intervening migration invalidates empty evidence before the next transform", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const calls: string[] = []
    MigrationRegistry.register("empty-input", [
      transform("01", calls),
      {
        id: "02",
        description: "Introduce a historical record",
        async up() {
          expect((await getMigrationStatus())["empty-input"].completed.map((item) => item.id)).toContain("01")
          await Storage.write(["input", "nested", "record"], { version: 1 })
        },
      },
      { ...transform("03", calls), dependsOn: ["02"] },
    ])
    expect((await runMigrations({ output: "silent" })).completed).toBe(3)
    expect(calls).toEqual(["03"])
    expect(await Storage.read<{ version: number }>(["input", "nested", "record"])).toEqual({ version: 2 })
  })
})

test("all declared inputs must be empty and their registration is immutable", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const calls: string[] = []
    const migration = { ...transform("01", calls), emptyInput: [["input"], ["other"]] }
    MigrationRegistry.register("empty-input", [migration])
    migration.emptyInput[1][0] = "changed-after-registration"
    await Storage.write(["other", "record"], true)
    await runMigrations({ output: "silent" })
    expect(calls).toEqual(["01"])
  })
})

test("failed grouped completion rolls back every domain and safely retries", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const calls: string[] = []
    MigrationRegistry.register("first", [transform("01", calls)])
    MigrationRegistry.register("second", [{ ...transform("02", calls), dependsOn: ["first/01"] }])
    const write = Storage.write
    const failure = spyOn(Storage, "write").mockImplementation(async (key, value) => {
      if (key.join("/") === "meta/migration/log-second") throw new Error("completion storage unavailable")
      await write(key, value)
    })
    try {
      await expect(runMigrations({ output: "silent" })).rejects.toThrow("completion storage unavailable")
    } finally {
      failure.mockRestore()
    }
    expect((await getMigrationStatus()).first.pending.map((item) => item.id)).toEqual(["01"])
    expect((await getMigrationStatus()).second.pending.map((item) => item.id)).toEqual(["02"])
    expect((await runMigrations({ output: "silent" })).completed).toBe(2)
    expect(calls).toEqual([])
  })
})

test("unfinished historical cohorts keep their existing startup boundary", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const calls: string[] = []
    MigrationRegistry.register("empty-input", [transform("01", calls)])
    await Storage.write(["compat_import", "cohorts", "empty-input", "01"], {
      domain: "empty-input",
      id: "01",
      residentComplete: false,
    })
    await runMigrations({ output: "silent" })
    expect(calls).toEqual(["01"])
    expect((await Storage.readMany([["compat_import", "cohorts", "empty-input", "01"]]))[0]).toBeUndefined()
  })
})

test("unmaterialized legacy sources are never treated as empty canonical input", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const calls: string[] = []
    MigrationRegistry.register("empty-input", [{ ...transform("01", calls), scope: "global", execution: "startup" }])
    const active = spyOn(SessionCompat, "isActive").mockResolvedValue(true)
    try {
      await runMigrations({ output: "silent" })
      expect(calls).toEqual(["01"])
    } finally {
      active.mockRestore()
    }
  })
})

test("empty input cannot bypass an unselected dependency or change dry-run state", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const calls: string[] = []
    MigrationRegistry.register("first", [transform("01", calls)])
    MigrationRegistry.register("second", [{ ...transform("02", calls), dependsOn: ["first/01"] }])
    await expect(runMigrations({ targetDomain: "second", output: "silent" })).rejects.toThrow("unfinished dependency")
    expect((await runMigrations({ output: "silent", dryRun: true })).dryRun).toBe(2)
    expect((await getMigrationStatus()).first.pending).toHaveLength(1)
    expect((await getMigrationStatus()).second.pending).toHaveLength(1)
    expect(calls).toEqual([])
  })
})
