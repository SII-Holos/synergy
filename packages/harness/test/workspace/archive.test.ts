import { expect, test } from "bun:test"
import { WorkspaceArchive } from "../../src/workspace/archive"
import { WorkspaceBlobs, WorkspaceContent } from "../../src/workspace/content"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"

test("saved Workspace archives restore bytes into new storage without carrying live authority", async () => {
  await using runtime = await testRuntime({
    register() {
      for (const name of ["source", "target"])
        WorkspaceBlobs.register(name, {
          put: (hash, bytes) => Storage.writeBinary([name, hash], bytes),
          get: (hash) => Storage.readBinary([name, hash]),
        })
    },
  })
  await runtime.run(async () => {
    const source = await WorkspaceCatalog.create({
      scopeID: "scope",
      backend: { provider: "objects", spec: { blobStore: "source" } },
    })
    const saved = await WorkspaceContent.write(
      { workspaceID: source.id, scopeID: source.scopeID },
      {
        path: "binary",
        data: new Uint8Array([0, 255, 1]),
        expectedVersion: null,
      },
    )
    const snapshot = await WorkspaceArchive.saved({
      workspaceID: source.id,
      scopeID: source.scopeID,
      expectedRevision: saved.revision,
    })
    const contents = await new Response(WorkspaceArchive.stream(snapshot)).text()
    expect(contents).not.toContain("blobStore")
    expect(contents).not.toContain(source.id)
    const destination = { scopeID: "other", backend: { provider: "objects", spec: { blobStore: "target" } } }
    const restored = await WorkspaceArchive.restore(destination, WorkspaceArchive.parse(new Blob([contents]).stream()))
    expect(restored.id).not.toBe(source.id)
    expect(restored.activeMount).toBeUndefined()
    expect(restored.sharedWritableWorkspaceIDs).toEqual([])
    expect(await WorkspaceContent.read({ workspaceID: restored.id, scopeID: "other" }, "binary")).toEqual(
      new Uint8Array([0, 255, 1]),
    )
    await expect(
      WorkspaceArchive.saved({ workspaceID: source.id, scopeID: source.scopeID, expectedRevision: 1 }),
    ).rejects.toMatchObject({ name: "WorkspaceBindingChanged" })
    const before = await WorkspaceCatalog.list("other")
    for (const invalid of [
      contents.slice(0, contents.lastIndexOf('{"kind":"end"')),
      contents.replace("AP8B", "AAAA"),
      contents + "{}\n",
    ]) {
      await expect(
        WorkspaceArchive.restore(destination, WorkspaceArchive.parse(new Blob([invalid]).stream())),
      ).rejects.toThrow()
      expect(await WorkspaceCatalog.list("other")).toEqual(before)
    }
    expect(await Storage.list(["environment"])).toEqual([])
  })
})
