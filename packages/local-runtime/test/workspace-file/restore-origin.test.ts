import { expect, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { SnapshotRestore } from "@ericsanchezok/synergy-harness/session/snapshot-restore"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { testEnvironmentRuntime } from "@ericsanchezok/synergy-harness/test/support/environment-origin"
import { testRuntime } from "../support/runtime"

test("file restoration uses its registered Host but never replaces a selected frame missing its origin", async () => {
  await using runtime = await testEnvironmentRuntime(
    {
      register() {
        WorkspaceBlobs.register("restore-fixture", {
          put: (hash, bytes) => Storage.writeBinary(["restore-fixture", hash], bytes),
          get: (hash) => Storage.readBinary(["restore-fixture", hash]),
        })
      },
    },
    testRuntime,
  )
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const workspace = await WorkspaceCatalog.create({
          scopeID: "home",
          backend: { provider: "objects", spec: { blobStore: "restore-fixture" } },
        })
        const selection = { scopeID: "home", workspaceID: workspace.id }
        await WorkspaceContent.write(selection, {
          path: "file.txt",
          data: new TextEncoder().encode("current"),
          expectedVersion: null,
        })
        let reads = 0
        const file: SnapshotRestore.File = {
          file: "file.txt",
          workspace: {
            id: workspace.id,
            generation: workspace.binding.generation,
            root: "",
            pathKind: "workspace",
          },
          mode: "100644",
          async read() {
            reads++
            return new TextEncoder().encode("historical")
          },
        }
        await using resources = await EnvironmentResources.resolve({
          ...selection,
          origin: runtime.origin("restore"),
          needs: { workspace: true },
        })
        const rejected = await EnvironmentResources.provide({ ...resources, origin: undefined }, "missing-origin", () =>
          SnapshotRestore.apply({ files: [file] }),
        )
        expect(rejected.restoredFiles).toEqual([])
        expect(rejected.failedFiles).toMatchObject([
          { code: "restore_failed", message: "File restoration requires its original resource origin" },
        ])
        expect(reads).toBe(0)
        expect(new TextDecoder().decode(await WorkspaceContent.read(selection, "file.txt"))).toBe("current")
        const restored = await SnapshotRestore.apply({ files: [file] })
        expect(restored.failedFiles).toEqual([])
        expect(restored.restoredFiles).toEqual(["file.txt"])
        expect(reads).toBe(1)
        expect(new TextDecoder().decode(await WorkspaceContent.read(selection, "file.txt"))).toBe("historical")
      },
    }),
  )
}, 15_000)
