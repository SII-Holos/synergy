import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { SnapshotMaintenance } from "../../src/session/snapshot-maintenance"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { tmpdir } from "../support/fixture"

async function fixture() {
  const tmp = await tmpdir({ git: true })
  const scope = await tmp.scope()
  const directory = path.dirname(SnapshotStore.legacyRepository(scope.id, "borrower"))
  const pool = path.join(directory, ".shared.old")
  const borrower = path.join(directory, "borrower")
  await SnapshotStore.initializeBareRepository(pool)
  await SnapshotStore.initializeBareRepository(borrower)
  await Bun.write(path.join(tmp.path, "file.txt"), "pooled history")
  await SnapshotStore.command(pool, ["-C", tmp.path, "--work-tree", tmp.path, "add", "file.txt"])
  const tree = await SnapshotStore.command(pool, ["write-tree"])
  await SnapshotStore.command(pool, ["update-ref", "refs/synergy/old", tree])
  await SnapshotStore.command(pool, ["repack", "-ad", "--keep-unreachable"])
  await Bun.write(path.join(tmp.path, "unknown.txt"), "unreferenced pool evidence")
  const unknown = await SnapshotStore.command(pool, ["hash-object", "-w", path.join(tmp.path, "unknown.txt")])
  const loose = path.join(pool, "objects", unknown.slice(0, 2), unknown.slice(2))
  await Bun.write(path.join(pool, "objects", "notes.txt"), "unclassified artifact")
  await Bun.write(
    path.join(borrower, "objects", "info", "alternates"),
    path.relative(path.join(borrower, "objects"), path.join(pool, "objects")) + "\n",
  )
  return { tmp, scope, pool, borrower, tree, unknown, loose }
}

test("scope migration consolidates an unowned pool while retaining borrowers and portable paths", async () => {
  const { tmp, scope, pool, borrower, tree, unknown, loose } = await fixture()
  await using cleanup = tmp
  const dry = await SnapshotMaintenance.migrate(scope.id)
  expect(dry.applied).toBe(false)
  expect(dry.pool?.status).toBe("pending")
  expect(await Bun.file(loose).exists()).toBe(true)
  const result = await SnapshotMaintenance.migrate(scope.id, { apply: true })
  expect(result.pool?.status).toBe("consolidated")
  expect(await Bun.file(loose).exists()).toBe(false)
  expect((await fs.readdir(path.join(pool, "objects", "pack"))).filter((name) => /\.(pack|idx)$/.test(name))).toEqual(
    [],
  )
  expect(await Bun.file(path.join(pool, "objects", "notes.txt")).text()).toBe("unclassified artifact")
  expect(await SnapshotStore.owner(scope.id, "borrower")).toBeUndefined()
  expect(await SnapshotStore.command(pool, ["rev-parse", "refs/synergy/old"])).toBe(tree)
  await SnapshotMaintenance.compact(scope.id, { apply: true, prune: true })
  expect(await SnapshotStore.command(borrower, ["show", `${tree}:file.txt`])).toBe("pooled history")
  expect(await SnapshotStore.command(pool, ["cat-file", "-p", unknown])).toBe("unreferenced pool evidence")
  expect((await SnapshotMaintenance.migrate(scope.id, { apply: true })).applied).toBe(false)
  const moved = path.join(tmp.path, "moved")
  await fs.cp(path.dirname(pool), path.join(moved, "snapshot", scope.id), { recursive: true })
  await fs.cp(SnapshotStore.root(scope.id), path.join(moved, "snapshot-v2", scope.id), { recursive: true })
  expect(
    await SnapshotStore.command(path.join(moved, "snapshot", scope.id, "borrower"), ["show", `${tree}:file.txt`]),
  ).toBe("pooled history")
})

for (const phase of ["rename", "file-sync", "directory-sync", "cleanup"] as const) {
  test.skipIf(process.platform === "win32" && phase === "directory-sync")(
    `pool consolidation resumes after interrupted ${phase} without losing borrowed objects`,
    async () => {
      const { tmp, scope, pool, borrower, tree, loose } = await fixture()
      await using cleanup = tmp
      const alternate = path.join(pool, "objects", "info", "alternates")
      const rename = fs.rename
      const open = fs.open
      const rm = fs.rm
      {
        using renameFault = spyOn(fs, "rename").mockImplementation(async (...args) => {
          if (phase === "rename" && args[1] === alternate) throw new Error("interrupted pool rename")
          return rename(...args)
        })
        using syncFault = spyOn(fs, "open").mockImplementation(async (...args) => {
          const file = await open(...args)
          if (
            (phase === "directory-sync" && args[0] === path.dirname(alternate)) ||
            (phase === "file-sync" && String(args[0]).startsWith(alternate + ".") && String(args[0]).endsWith(".tmp"))
          )
            file.sync = async () => {
              throw new Error("interrupted pool sync")
            }
          return file
        })
        using cleanupFault = spyOn(fs, "rm").mockImplementation(async (...args) => {
          await rm(...args)
          if (phase === "cleanup" && args[0] === loose) throw new Error("interrupted pool cleanup")
        })
        await expect(SnapshotMaintenance.migrate(scope.id, { apply: true })).rejects.toThrow("interrupted pool")
      }
      expect(await SnapshotStore.command(borrower, ["show", `${tree}:file.txt`])).toBe("pooled history")
      if (phase !== "cleanup") expect(await Bun.file(loose).exists()).toBe(true)
      expect((await SnapshotMaintenance.migrate(scope.id, { apply: true })).pool?.status).toBe("consolidated")
      await SnapshotGit.checked(SnapshotStore.repository(scope.id), ["fsck", "--full"])
      expect(await SnapshotStore.command(borrower, ["show", `${tree}:file.txt`])).toBe("pooled history")
    },
  )
}

test("pool consolidation waits for legacy owners and stays outside session pilots", async () => {
  const { tmp, scope, pool, loose } = await fixture()
  await using cleanup = tmp
  expect((await SnapshotMaintenance.migrate(scope.id, { apply: true, sessionID: "borrower" })).pool).toBeUndefined()
  await SnapshotStore.write(StoragePath.snapshotOwner(scope.id, "borrower"), { version: 2, backend: "legacy" })
  const blocked = await SnapshotMaintenance.migrate(scope.id, { apply: true })
  expect(blocked.pool?.status).toBe("blocked")
  expect(await Bun.file(loose).exists()).toBe(true)
  expect(await Bun.file(path.join(pool, "objects", "info", "alternates")).exists()).toBe(false)
  await Storage.remove(StoragePath.snapshotOwner(scope.id, "borrower"))
  expect((await SnapshotMaintenance.migrate(scope.id, { apply: true })).pool?.status).toBe("consolidated")
})
