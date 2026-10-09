import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { migrationFixture } from "../migration/fixture"
import { migrations } from "../../src/scope/migration"
import { ScopeLibraryStore } from "../../src/scope/library-store"
import { Global } from "../../src/global"
import { Storage } from "../../src/storage/storage"

const migration = migrations.find((entry) => entry.id === "20260624-scope-global-to-home")!

test("an empty scope history requires no authority mutations", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    await Storage.write(["unrelated", "record"], { keep: true })
    const remove = spyOn(Storage, "remove").mockRejectedValue(new Error("Unexpected empty authority mutation"))
    const tree = spyOn(Storage, "removeTree").mockRejectedValue(new Error("Unexpected empty authority mutation"))
    try {
      await migration.up(() => {})
      expect(remove).not.toHaveBeenCalled()
      expect(tree).not.toHaveBeenCalled()
      expect(await Storage.read<{ keep: boolean }>(["unrelated", "record"])).toEqual({ keep: true })
    } finally {
      remove.mockRestore()
      tree.mockRestore()
    }
  })
})

test("empty records still migrate a snapshot directory and registered library owner", async () => {
  const renamed: string[][] = []
  await using fixture = await migrationFixture({
    register() {
      ScopeLibraryStore.register({
        experienceScopeIDs: () => ["global"],
        removeExperiencesByScope: () => 0,
        renameExperienceScope(from, to) {
          renamed.push([from, to])
          return 1
        },
      })
    },
  })
  await fixture.run(async () => {
    const source = path.join(Global.Path.snapshot, "global")
    const destination = path.join(Global.Path.snapshot, "home")
    await fs.mkdir(source, { recursive: true })
    await fs.writeFile(path.join(source, "retained"), "snapshot bytes")
    await migration.up(() => {})
    expect(await fs.readFile(path.join(destination, "retained"), "utf8")).toBe("snapshot bytes")
    expect(await fs.stat(source).catch(() => undefined)).toBeUndefined()
    expect(renamed).toEqual([["global", "home"]])
  })
})

test("home-only indexes and legacy permission records remain migration inputs", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    await Storage.write(["session_index", "session-retained"], { scopeID: "global", preserved: 42 })
    await Storage.write(["permissions", "global"], { denied: ["bash"] })
    await Storage.write(["stats", "snapshot"], { obsolete: true })
    await migration.up(() => {})
    expect(
      await Storage.read<{ scopeID: string; directory: string; preserved: number }>([
        "session_index",
        "session-retained",
      ]),
    ).toEqual({
      scopeID: "home",
      directory: Global.Path.home,
      preserved: 42,
    })
    expect(await Storage.read<{ denied: string[] }>(["permissions", "home"])).toEqual({ denied: ["bash"] })
    expect(
      await Storage.readMany([
        ["permissions", "global"],
        ["stats", "snapshot"],
      ]),
    ).toEqual([undefined, undefined])
    await migration.up(() => {})
    expect(await Storage.read<{ denied: string[] }>(["permissions", "home"])).toEqual({ denied: ["bash"] })
  })
})

test("failed root discovery cannot prove empty history", async () => {
  await using fixture = await migrationFixture()
  await fixture.run(async () => {
    const scan = spyOn(Storage, "scan").mockRejectedValue(new Error("Authority unavailable"))
    try {
      await expect(migration.up(() => {})).rejects.toThrow("Authority unavailable")
    } finally {
      scan.mockRestore()
    }
  })
})
