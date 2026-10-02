import { expect, test } from "bun:test"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { WorkspaceContent, WorkspaceBlobs } from "../../src/workspace/content"
import { Bus } from "../../src/bus"
import { ScopeContext } from "../../src/scope/context"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "../support/fixture"

test("object catalog creation and head publication emit monotonic revisions after commit", async () => {
  await using runtime = await testRuntime({
    register() {
      WorkspaceBlobs.register("fixture", {
        put: (hash, bytes) => Storage.writeBinary(["test_blobs", hash], bytes),
        get: (hash) => Storage.readBinary(["test_blobs", hash]),
      })
    },
  })
  await runtime.run(async () => {
    await using fixture = await tmpdir()
    const scope = await fixture.scope()
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        const events: WorkspaceCatalog.Info[] = []
        const unsubscribe = Bus.subscribe(WorkspaceCatalog.Event.Updated, (event) => {
          events.push(event.properties)
        })
        try {
          const workspace = await WorkspaceCatalog.create({
            scopeID: scope.id,
            backend: { provider: "objects", spec: { blobStore: "fixture" } },
          })
          await WorkspaceContent.write(
            { workspaceID: workspace.id, scopeID: scope.id },
            { path: "file", data: new Uint8Array([1]), expectedVersion: null },
          )
          expect(events.map((event) => event.revision)).toEqual([1, 2])
          expect(events[1]?.content?.manifest).toBe(
            (await WorkspaceCatalog.get(workspace.id, scope.id)).content?.manifest,
          )
          await expect(
            Storage.transaction(async () => {
              await WorkspaceCatalog.create({ scopeID: scope.id, backend: { provider: "objects", spec: {} } })
              throw new Error("rollback")
            }),
          ).rejects.toThrow("rollback")
          expect(events).toHaveLength(2)
        } finally {
          unsubscribe()
        }
      },
    })
  })
})
