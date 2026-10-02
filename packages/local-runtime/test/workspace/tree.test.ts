import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import type { BlobStore } from "@ericsanchezok/synergy-harness/workspace/content"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { NativeWorkspaceTree } from "../../src/workspace/tree"

test("checkpoint restores chunked binary files, directories, permissions and links after its source disappears", async () => {
  await using tmp = await tmpdir()
  const source = path.join(tmp.path, "source")
  const destination = path.join(tmp.path, "destination")
  const objects = path.join(tmp.path, "objects")
  await fs.mkdir(path.join(source, "nested", "empty"), { recursive: true })
  await fs.mkdir(objects)
  const bytes = new Uint8Array(WorkspaceTree.chunkBytes + 17).fill(255)
  await Bun.write(path.join(source, "nested", "binary"), bytes)
  await fs.chmod(path.join(source, "nested", "binary"), 0o755)
  if (process.platform !== "win32") await fs.symlink("nested/binary", path.join(source, "link"))
  const store: BlobStore = {
    async put(hash, data) {
      await Bun.write(path.join(objects, hash), data)
    },
    async get(hash) {
      return new Uint8Array(await Bun.file(path.join(objects, hash)).arrayBuffer())
    },
  }
  const tree = await NativeWorkspaceTree.capture(source, store)
  await fs.rm(source, { recursive: true })
  await NativeWorkspaceTree.materialize(destination, tree, store)
  expect(new Uint8Array(await Bun.file(path.join(destination, "nested", "binary")).arrayBuffer())).toEqual(bytes)
  expect((await fs.stat(path.join(destination, "nested", "empty"))).isDirectory()).toBe(true)
  if (process.platform !== "win32") {
    expect((await fs.stat(path.join(destination, "nested", "binary"))).mode & 0o777).toBe(0o755)
    expect(await fs.readlink(path.join(destination, "link"))).toBe("nested/binary")
  }
  await expect(NativeWorkspaceTree.materialize(destination, tree, store)).rejects.toThrow("empty")
  const broken: BlobStore = { ...store, get: async () => new Uint8Array([1]) }
  await expect(NativeWorkspaceTree.materialize(path.join(tmp.path, "broken"), tree, broken)).rejects.toThrow(
    "integrity",
  )
  expect(await Bun.file(path.join(tmp.path, "broken", "nested", "binary")).exists()).toBe(false)
})

test.skipIf(process.platform === "win32")("checkpoint refuses escaping links and mutable source bytes", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, "source")
  await fs.mkdir(root)
  await Bun.write(path.join(root, "file"), "first")
  await expect(
    NativeWorkspaceTree.capture(root, {
      async put() {
        await Bun.write(path.join(root, "file"), "changed")
      },
      async get() {
        throw new Error("not used")
      },
    }),
  ).rejects.toThrow("changed")
  await fs.symlink("../outside", path.join(root, "link"))
  await expect(
    NativeWorkspaceTree.capture(root, {
      async put() {},
      async get() {
        throw new Error("not used")
      },
    }),
  ).rejects.toThrow("escapes")
})
