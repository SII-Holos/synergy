import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { tmpdir } from "../support/fixture"

async function fixture() {
  const tmp = await tmpdir({ git: true })
  const source = path.join(tmp.path, "source.git")
  const target = path.join(tmp.path, "target.git")
  await SnapshotStore.initializeBareRepository(source)
  await SnapshotStore.initializeBareRepository(target)
  const content = randomBytes(16 * 1024 * 1024)
  const blob = path.join(tmp.path, "large.bin")
  await Bun.write(blob, content)
  const oid = await SnapshotGit.checked(source, ["hash-object", "-w", blob])
  const inventory = path.join(tmp.path, "inventory")
  await Bun.write(inventory, oid + "\n")
  return { tmp, source, target, content, oid, inventory }
}

test("snapshot transfer reports a rejected destination and preserves its source for retry", async () => {
  const { tmp, source, target, oid, inventory } = await fixture()
  await using cleanup = tmp
  await SnapshotGit.checked(target, ["config", "core.repositoryformatversion", "999"])
  await expect(SnapshotGit.importObjects(source, target, inventory)).rejects.toThrow("index-pack")
  await fs.rm(target, { recursive: true })
  await SnapshotStore.initializeBareRepository(target)
  const keep = await SnapshotGit.importObjects(source, target, inventory)
  expect(await Bun.file(path.join(target, "objects", "pack", `pack-${keep}.keep`)).exists()).toBe(true)
  expect(await SnapshotGit.checked(target, ["cat-file", "-s", oid])).toBe(String(16 * 1024 * 1024))
  await SnapshotGit.checked(target, ["fsck", "--full"])
})

test("snapshot transfer preserves large object bytes and cleans its staging files", async () => {
  const { tmp, source, target, content, oid, inventory } = await fixture()
  await using cleanup = tmp
  const before = (await fs.readdir(tmp.path)).sort()
  await SnapshotGit.importObjects(source, target, inventory)
  const result = Bun.spawn(["git", "--git-dir", target, "cat-file", "blob", oid], {
    env: SnapshotGit.environment(),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [bytes, code] = await Promise.all([new Response(result.stdout).arrayBuffer(), result.exited])
  expect(code).toBe(0)
  expect(Buffer.from(bytes).equals(content)).toBe(true)
  expect((await fs.readdir(tmp.path)).sort()).toEqual(before)
})
