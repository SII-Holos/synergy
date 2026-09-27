import { expect, test } from "bun:test"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { WorkspaceContent, WorkspaceBlobs, type BlobStore } from "../../src/workspace/content"
import { WorkspaceTree } from "../../src/workspace/tree"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"

test("dormant object files commit immutable manifests with a transactional head, without compute", async () => {
  let fail = false
  const blobs: BlobStore = {
    async put(hash, bytes) {
      if (fail) throw new Error("object upload failed")
      await Storage.writeBinary(["test_blobs", hash], bytes)
    },
    get: (hash) => Storage.readBinary(["test_blobs", hash]),
  }
  await using runtime = await testRuntime({ register: () => WorkspaceBlobs.register("fixture", blobs) })
  await runtime.run(async () => {
    const workspace = await WorkspaceCatalog.create({
      scopeID: "scope",
      backend: { provider: "objects", spec: { blobStore: "fixture" } },
    })
    const input = { workspaceID: workspace.id, scopeID: "scope", generation: workspace.binding.generation }
    const first = await WorkspaceContent.write(input, {
      path: "hello.txt",
      data: new TextEncoder().encode("first"),
      expectedVersion: null,
    })
    expect(await WorkspaceContent.read(input, "hello.txt")).toEqual(new TextEncoder().encode("first"))
    expect(first.content?.revision).toBe(1)
    const outcomes = await Promise.allSettled([
      WorkspaceContent.write(input, {
        path: "hello.txt",
        data: new TextEncoder().encode("second"),
        expectedVersion: WorkspaceTree.hash(new TextEncoder().encode("first")),
      }),
      WorkspaceContent.write(input, {
        path: "hello.txt",
        data: new TextEncoder().encode("third"),
        expectedVersion: WorkspaceTree.hash(new TextEncoder().encode("first")),
      }),
    ])
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    const head = await WorkspaceCatalog.get(workspace.id, "scope")
    fail = true
    await expect(
      WorkspaceContent.write(input, { path: "other.txt", data: new Uint8Array([0, 255]), expectedVersion: null }),
    ).rejects.toThrow("upload failed")
    expect((await WorkspaceCatalog.get(workspace.id, "scope")).content).toEqual(head.content)
    expect(await Storage.list(["environment"])).toHaveLength(0)
    await expect(WorkspaceContent.read({ ...input, generation: 999 }, "hello.txt")).rejects.toMatchObject({
      name: "WorkspaceBindingChanged",
    })
    const imported = await WorkspaceCatalog.importRecord(workspace)
    await expect(WorkspaceContent.read({ ...input, workspaceID: imported.id }, "hello.txt")).rejects.toMatchObject({
      name: "WorkspaceUnavailable",
    })
  })
})

test("content manifests reject traversal, duplicate paths, escaping links and missing parents", () => {
  const directory = { path: "a", kind: "directory", mode: 0o755 }
  for (const entries of [
    [{ ...directory, path: "../a" }],
    [directory, directory],
    [{ path: "link", kind: "symlink", mode: 0o777, target: "../outside" }],
    [{ ...directory, path: "missing/child" }],
  ])
    expect(() => WorkspaceTree.Manifest.parse({ version: 1, entries })).toThrow()
})
