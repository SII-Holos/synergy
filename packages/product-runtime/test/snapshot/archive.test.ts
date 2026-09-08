import { expect, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { SnapshotArchive } from "@ericsanchezok/synergy-harness/session/snapshot-archive"
import { SnapshotStore } from "@ericsanchezok/synergy-harness/session/snapshot-store"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { createDataArchive } from "../../src/cli/data/pack"

test("full data pack makes legacy alternates portable", async () => {
  await using tmp = await tmpdir({ git: true })
  const home = path.join(tmp.path, "home")
  const scope = path.join(home, "data", "snapshot", "scope-old")
  const shared = path.join(scope, ".shared.old")
  const session = path.join(scope, "session-old")
  await SnapshotStore.initializeBareRepository(shared)
  await SnapshotStore.initializeBareRepository(session)
  await Bun.write(path.join(tmp.path, "file.txt"), "legacy history")
  await SnapshotStore.command(shared, ["-C", tmp.path, "--work-tree", tmp.path, "add", "file.txt"])
  const tree = await SnapshotStore.command(shared, ["write-tree"])
  await Bun.write(path.join(session, "objects", "info", "alternates"), path.join(shared, "objects") + "\n")
  await Bun.write(path.join(home, "cache", "snapshot-index", "derived"), "rebuildable")
  const archive = await createDataArchive(home, path.join(tmp.path, "backup.zip"), ["data", "state", "cache"], {
    version: 1,
  })
  await fs.rm(home, { recursive: true })
  const extracted = path.join(tmp.path, "extracted")
  await fs.mkdir(extracted)
  if (archive.endsWith(".zip")) await $`unzip -q ${archive} -d ${extracted}`.quiet()
  else await $`tar -xzf ${archive} -C ${extracted}`.quiet()
  expect(await Bun.file(path.join(extracted, "state", "daemon", "runtime-lock.json")).exists()).toBe(false)
  expect(await Bun.file(path.join(extracted, "cache", "snapshot-index", "derived")).exists()).toBe(false)
  const restored = path.join(extracted, "data", "snapshot", "scope-old", "session-old")
  expect(await Bun.file(path.join(restored, "objects", "info", "alternates")).exists()).toBe(false)
  expect(await SnapshotStore.command(restored, ["show", `${tree}:file.txt`])).toBe("legacy history")
})

test("data merge unions packed snapshot refs and objects without the original home", async () => {
  await using tmp = await tmpdir({ git: true })
  const roots: string[] = []
  for (const side of ["source", "target"]) {
    const data = path.join(tmp.path, side)
    const scope = path.join(data, "snapshot-v2", "scope-test")
    const repo = path.join(scope, "store.git")
    await SnapshotStore.initializeBareRepository(repo)
    await Bun.write(path.join(tmp.path, "file.txt"), side)
    await SnapshotStore.command(repo, ["-C", tmp.path, "--work-tree", tmp.path, "add", "file.txt"])
    const tree = await SnapshotStore.command(repo, ["write-tree"])
    roots.push(tree)
    await SnapshotStore.command(repo, ["update-ref", SnapshotStore.reference("session-test", tree), tree])
    await SnapshotStore.command(repo, ["pack-refs", "--all"])
    await Storage.writeJsonAtomic(
      path.join(scope, "owners", "session-test.json"),
      JSON.stringify({ version: 2, backend: "shared" }),
    )
    await Storage.writeJsonAtomic(
      path.join(scope, "repository.json"),
      JSON.stringify({ version: 2, objectFormat: "sha1" }),
    )
  }
  const source = path.join(tmp.path, "source")
  const target = path.join(tmp.path, "target")
  await SnapshotArchive.merge(source, target)
  await fs.rm(source, { recursive: true })
  const repo = path.join(target, "snapshot-v2", "scope-test", "store.git")
  for (const tree of roots)
    expect(await SnapshotStore.command(repo, ["rev-parse", SnapshotStore.reference("session-test", tree)])).toBe(tree)
  expect(await SnapshotStore.command(repo, ["show", `${roots[0]}:file.txt`])).toBe("source")
  await SnapshotStore.command(repo, ["fsck", "--full"])
})
