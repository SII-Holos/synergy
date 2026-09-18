import { expect, test, spyOn } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { SnapshotMaintenance } from "../../src/session/snapshot-maintenance"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { tmpdir } from "../support/fixture"

async function fixture() {
  const tmp = await tmpdir()
  const data = path.join(tmp.path, "data")
  const repo = path.join(data, "snapshot", "scope", "session")
  await SnapshotStore.initializeBareRepository(repo)
  await Bun.write(path.join(tmp.path, "file.txt"), "recoverable contents")
  await SnapshotStore.command(repo, ["-C", tmp.path, "--work-tree", tmp.path, "add", "file.txt"])
  const tree = await SnapshotStore.command(repo, ["write-tree"])
  await Bun.write(path.join(tmp.path, "unknown.txt"), "unreferenced evidence")
  const unknown = await SnapshotStore.command(repo, ["hash-object", "-w", path.join(tmp.path, "unknown.txt")])
  await SnapshotStore.command(repo, ["update-ref", "refs/synergy/snapshots/session/" + tree, tree])
  return { tmp, data, repo, tree, unknown }
}

test("packs unreferenced loose objects and preserves exact snapshot reconstruction without a database", async () => {
  const { tmp, data, repo, tree, unknown } = await fixture()
  await using cleanup = tmp
  const before: string[] = []
  for await (const oid of SnapshotGit.lines(repo, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]))
    before.push(oid)
  const dry = await SnapshotMaintenance.packLegacy(data, { scopeID: "scope" })
  expect(dry.results[0].applied).toBe(false)
  expect(await Bun.file(path.join(repo, "objects", unknown.slice(0, 2), unknown.slice(2))).exists()).toBe(true)
  const applied = await SnapshotMaintenance.packLegacy(data, { scopeID: "scope", apply: true })
  expect(applied.results[0].packedObjects).toBe(before.length)
  expect(await Bun.file(path.join(repo, "objects", unknown.slice(0, 2), unknown.slice(2))).exists()).toBe(false)
  const after: string[] = []
  for await (const oid of SnapshotGit.lines(repo, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]))
    after.push(oid)
  expect(after.sort()).toEqual(before.sort())
  expect(await SnapshotStore.command(repo, ["show", tree + ":file.txt"])).toBe("recoverable contents")
  expect(await SnapshotStore.command(repo, ["cat-file", "-p", unknown])).toBe("unreferenced evidence")
  expect(await SnapshotStore.command(repo, ["rev-parse", "refs/synergy/snapshots/session/" + tree])).toBe(tree)
  expect((await SnapshotMaintenance.packLegacy(data, { scopeID: "scope", apply: true })).results[0].packedObjects).toBe(
    0,
  )
})

test("keeps loose originals if pack verification fails and resumes safely", async () => {
  const { tmp, data, repo, unknown } = await fixture()
  await using cleanup = tmp
  const checked = SnapshotGit.checked
  {
    using failure = spyOn(SnapshotGit, "checked").mockImplementation(async (repository, args, options) => {
      if (args[0] === "verify-pack") {
        await Bun.write(args.at(-1)!.replace(/\.idx$/, ".pack"), "corrupt pack")
        throw new Error("injected pack verification failure")
      }
      return checked(repository, args, options)
    })
    const result = await SnapshotMaintenance.packLegacy(data, { scopeID: "scope", apply: true })
    expect(result.ok).toBe(false)
    expect(await Bun.file(path.join(repo, "objects", unknown.slice(0, 2), unknown.slice(2))).exists()).toBe(true)
    expect((await fs.readdir(path.join(repo, "objects", "pack"))).filter((name) => /\.(pack|idx)$/.test(name))).toEqual(
      [],
    )
  }
  expect((await SnapshotMaintenance.packLegacy(data, { scopeID: "scope", apply: true })).ok).toBe(true)
  expect(await SnapshotStore.command(repo, ["cat-file", "-p", unknown])).toBe("unreferenced evidence")
  await SnapshotGit.checked(repo, ["fsck", "--full", "--no-dangling"])
})

test("packs only local loose objects while retaining an alternate dependency", async () => {
  const { tmp, data, repo, tree } = await fixture()
  await using cleanup = tmp
  const source = path.join(data, "snapshot", "scope", "borrower")
  await SnapshotStore.initializeBareRepository(source)
  await fs.writeFile(path.join(source, "objects", "info", "alternates"), path.join(repo, "objects") + "\n")
  await Bun.write(path.join(tmp.path, "local.txt"), "local evidence")
  const local = await SnapshotStore.command(source, ["hash-object", "-w", path.join(tmp.path, "local.txt")])
  const result = await SnapshotMaintenance.packLegacy(data, { scopeID: "scope", sessionID: "borrower", apply: true })
  expect(result.ok).toBe(true)
  expect(result.results[0].packedObjects).toBe(1)
  expect(await Bun.file(path.join(repo, "objects", tree.slice(0, 2), tree.slice(2))).exists()).toBe(true)
  expect(await SnapshotStore.command(source, ["show", tree + ":file.txt"])).toBe("recoverable contents")
  expect(await SnapshotStore.command(source, ["cat-file", "-p", local])).toBe("local evidence")
})

test("refuses to change source files once an interrupted storage backup exists", async () => {
  const { tmp, data } = await fixture()
  await using cleanup = tmp
  await fs.mkdir(path.join(data, "storage", "backups", "partial"), { recursive: true })
  await Bun.write(
    path.join(data, "storage", "manifest.json"),
    JSON.stringify({
      version: 1,
      namespace: "fixture",
      backend: "sqlite",
      target: "fixture",
      artifactStoreID: crypto.randomUUID(),
      backupID: crypto.randomUUID(),
      phase: "importing",
    }),
  )
  await expect(SnapshotMaintenance.packLegacy(data, { apply: true })).rejects.toThrow("interrupted storage backup")
})
