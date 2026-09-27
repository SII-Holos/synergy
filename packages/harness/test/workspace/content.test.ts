import { expect, test } from "bun:test"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { WorkspaceContent, WorkspaceBlobs, type BlobStore } from "../../src/workspace/content"
import { WorkspaceTree } from "../../src/workspace/tree"
import { WorkspaceOperations } from "../../src/workspace/operations"
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
        expectedVersion: `sha256:${WorkspaceTree.hash(new TextEncoder().encode("first"))}`,
      }),
      WorkspaceContent.write(input, {
        path: "hello.txt",
        data: new TextEncoder().encode("third"),
        expectedVersion: `sha256:${WorkspaceTree.hash(new TextEncoder().encode("first"))}`,
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

test("bounded object reads follow contained links and only fetch intersecting chunks", async () => {
  const reads: string[] = []
  const blobs: BlobStore = {
    put: (hash, bytes) => Storage.writeBinary(["test_blobs", hash], bytes),
    get(hash) {
      reads.push(hash)
      return Storage.readBinary(["test_blobs", hash])
    },
  }
  await using runtime = await testRuntime({ register: () => WorkspaceBlobs.register("fixture", blobs) })
  await runtime.run(async () => {
    let info = await WorkspaceCatalog.create({
      scopeID: "scope",
      backend: { provider: "objects", spec: { blobStore: "fixture" } },
    })
    const selection = { scopeID: info.scopeID, workspaceID: info.id }
    const data = new Uint8Array(WorkspaceTree.chunkBytes + 16).fill(7)
    data.fill(9, WorkspaceTree.chunkBytes)
    info = await WorkspaceContent.write(selection, { path: "file", data, expectedVersion: null })
    const tree = await WorkspaceContent.manifest(info, blobs)
    info = await WorkspaceContent.publish(info, blobs, {
      ...tree,
      entries: [
        ...tree.entries,
        { path: "link", kind: "symlink", mode: 0o777, target: "file" },
        { path: "cycle", kind: "symlink", mode: 0o777, target: "cycle" },
      ],
    })
    reads.length = 0
    const range = await WorkspaceContent.readRange(selection, "link", WorkspaceTree.chunkBytes + 2, 4)
    expect([...range.bytes]).toEqual([9, 9, 9, 9])
    expect(range.version).toBe(`sha256:${WorkspaceTree.hash(data)}`)
    expect(reads).toHaveLength(2)
    await expect(WorkspaceContent.read(selection, "cycle")).rejects.toThrow("cycle")
    await WorkspaceContent.write(selection, { path: "link", data: new Uint8Array([1]), expectedVersion: range.version })
    expect([...(await WorkspaceContent.read(selection, "file"))]).toEqual([1])
    const latest = await WorkspaceCatalog.get(info.id, info.scopeID)
    expect((await WorkspaceContent.manifest(latest, blobs)).entries.find((entry) => entry.path === "link")?.kind).toBe(
      "symlink",
    )
  })
})

test("object directory operations commit their receipt with the head and allocate no compute", async () => {
  const blobs: BlobStore = {
    put: (hash, bytes) => Storage.writeBinary(["test_blobs", hash], bytes),
    get: (hash) => Storage.readBinary(["test_blobs", hash]),
  }
  await using runtime = await testRuntime({ register: () => WorkspaceBlobs.register("fixture", blobs) })
  await runtime.run(async () => {
    const info = await WorkspaceCatalog.create({
      scopeID: "scope",
      backend: { provider: "objects", spec: { blobStore: "fixture" } },
    })
    const input = { scopeID: info.scopeID, workspaceID: info.id }
    await WorkspaceOperations.mutate({
      ...input,
      id: "mkdir",
      change: { kind: "mkdir", path: "a/b", createParents: true },
    })
    const write = { ...input, id: "write", path: "a/b/file", data: new Uint8Array([1, 2]), expectedVersion: null }
    await WorkspaceOperations.write(write)
    await WorkspaceOperations.write(write)
    expect((await WorkspaceCatalog.get(info.id, info.scopeID)).content?.revision).toBe(2)
    expect((await WorkspaceOperations.get("write", info.scopeID)).state).toBe("completed")
    const version = async (filename: string) => {
      const current = await WorkspaceCatalog.get(info.id, info.scopeID)
      const tree = await WorkspaceContent.manifest(current, blobs)
      return WorkspaceTree.entryVersion(
        tree.entries.find((entry) => entry.path === filename)!,
        current.content?.revision,
      )
    }
    await WorkspaceOperations.mutate({
      ...input,
      id: "copy",
      change: { kind: "copy", from: "a", to: "copy", expectedVersion: await version("a") },
    })
    await expect(
      WorkspaceOperations.mutate({
        ...input,
        id: "conflict",
        change: { kind: "remove", path: "a", recursive: true, expectedVersion: "stale" },
      }),
    ).rejects.toThrow("changed")
    await WorkspaceOperations.mutate({
      ...input,
      id: "move",
      change: { kind: "move", from: "a", to: "moved", expectedVersion: await version("a") },
    })
    await WorkspaceOperations.mutate({
      ...input,
      id: "remove",
      change: { kind: "remove", path: "moved", recursive: true, expectedVersion: await version("moved") },
    })
    expect([...(await WorkspaceContent.read(input, "copy/b/file"))]).toEqual([1, 2])
    await expect(WorkspaceContent.read(input, "moved/b/file")).rejects.toThrow("absent")
    expect(await Storage.list(["environment"])).toHaveLength(0)
    expect(await Storage.list(["workspace_operation_active"])).toHaveLength(0)
  })
})
