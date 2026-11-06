import { expect, spyOn, test } from "bun:test"
import { Snapshot } from "../../src/session/snapshot"
import { SnapshotGit } from "../../src/session/snapshot-git"
import { SnapshotStore } from "../../src/session/snapshot-store"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { WorkspaceBlobs, WorkspaceContent, type BlobStore } from "../../src/workspace/content"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { WorkspaceTree } from "../../src/workspace/tree"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

test("object Workspace imports retain bytes and never turn store failures into read omissions", async () => {
  const blobs: BlobStore = {
    put: (hash, bytes) => Storage.writeBinary(["capture_fixture", hash], bytes),
    get: (hash) => Storage.readBinary(["capture_fixture", hash]),
  }
  await using runtime = await testRuntime({ register: () => WorkspaceBlobs.register("capture-fixture", blobs) })
  await runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        let info = await WorkspaceCatalog.create({
          scopeID: ScopeContext.current.scope.id,
          backend: { provider: "objects", spec: { blobStore: "capture-fixture" } },
        })
        const entries: WorkspaceTree.Entry[] = []
        const add = async (name: string, bytes: Uint8Array) => {
          const hash = WorkspaceTree.hash(bytes)
          await blobs.put(hash, bytes)
          entries.push({
            path: name,
            kind: "file",
            mode: 0o644,
            size: bytes.length,
            hash,
            chunks: [{ hash, size: bytes.length }],
          })
        }
        for (let index = 0; index < 65; index++) await add(`${index}.txt`, new Uint8Array([0, 255, index]))
        info = await WorkspaceContent.publish(info, blobs, { version: 1, entries })
        const first = await Snapshot.trackContent(info, info.content!.manifest, "object-first")
        const second = await Snapshot.trackContent(info, info.content!.manifest, "object-second")
        expect(second).toBe(first)
        const repo = SnapshotStore.repository(info.scopeID)
        expect((await SnapshotGit.run(["git", "--git-dir", repo, "show", `${first}:0.txt`], tmp.path)).bytes).toEqual(
          new Uint8Array([0, 255, 0]),
        )
        expect(await SnapshotStore.owns(info.scopeID, "object-second", first)).toBe(true)
        for (let index = 0; index < 8; index++)
          await add(`large-${index}.txt`, new Uint8Array(2 * 1024 * 1024).fill(index))
        info = await WorkspaceContent.publish(info, blobs, { version: 1, entries })
        const failure = spyOn(SnapshotGit, "blobWriter").mockRejectedValue(
          new SnapshotStore.StorageError("controlled import failure"),
        )
        let omissions = 0
        try {
          await expect(
            Snapshot.trackContent(info, info.content!.manifest, "object-failed", undefined, () => omissions++),
          ).rejects.toThrow("controlled import failure")
          expect(omissions).toBe(0)
          expect(await SnapshotStore.owns(info.scopeID, "object-second", first)).toBe(true)
        } finally {
          failure.mockRestore()
        }
        expect(await Snapshot.trackContent(info, info.content!.manifest, "object-failed")).toBeTruthy()
      },
    })
  })
})
