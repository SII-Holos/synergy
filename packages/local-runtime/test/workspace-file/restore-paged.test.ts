import { expect, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import { WorkspacePortableTree as Portable } from "@ericsanchezok/synergy-harness/workspace/portable-tree"
import { SessionTransferStream as Stream } from "@ericsanchezok/synergy-harness/session/transfer"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { SnapshotRestore } from "@ericsanchezok/synergy-harness/session/snapshot-restore"
import { testEnvironmentRuntime } from "@ericsanchezok/synergy-harness/test/support/environment-origin"
import { testRuntime } from "../support/runtime"

test("actual snapshot restoration preserves multi-file version checks on a paged Workspace", async () => {
  const store = {
    put: (hash: string, bytes: Uint8Array) => Storage.writeBinary(["restore-paged", hash], bytes),
    get: (hash: string) => Storage.readBinary(["restore-paged", hash]),
  }
  await using runtime = await testEnvironmentRuntime(
    { register: () => WorkspaceBlobs.register("restore-paged", store) },
    testRuntime,
  )
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        let workspace = await WorkspaceCatalog.create({
          scopeID: "home",
          backend: { provider: "objects", spec: { blobStore: "restore-paged" } },
        })
        const tree: Portable.Root = {
          version: 1,
          mode: 0o755,
          tree: await Stream.write({
            store,
            owners: { "workspace-files": 1 },
            entries: (async function* (): AsyncGenerator<Stream.Input> {
              for (let index = 0; index < 513; index++)
                yield {
                  id: `file-${String(index).padStart(4, "0")}`,
                  kind: "file",
                  metadata: { version: 1, kind: "file", mode: 0o644 },
                  content: (async function* () {
                    yield new TextEncoder().encode("current")
                  })(),
                }
            })(),
          }),
        }
        const bytes = new TextEncoder().encode(JSON.stringify(tree))
        const manifest = WorkspaceTree.hash(bytes)
        await store.put(manifest, bytes)
        workspace = await WorkspaceCatalog.publishContent(workspace, manifest)
        const files: SnapshotRestore.File[] = [0, 512].map((index) => ({
          file: `file-${String(index).padStart(4, "0")}`,
          workspace: { id: workspace.id, generation: workspace.binding.generation, root: "", pathKind: "workspace" },
          mode: "100644",
          async read() {
            return new TextEncoder().encode(`restored-${index}`)
          },
        }))
        const restored = await SnapshotRestore.apply({ files })
        expect(restored.failedFiles).toEqual([])
        expect(restored.restoredFiles).toEqual(files.map((file) => file.file))
        expect(
          new TextDecoder().decode(
            await WorkspaceContent.read({ scopeID: "home", workspaceID: workspace.id }, "file-0512"),
          ),
        ).toBe("restored-512")
      },
    }),
  )
}, 20000)
