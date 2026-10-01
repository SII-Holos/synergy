import { expect, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs } from "@ericsanchezok/synergy-harness/workspace/content"
import { FileView } from "../../src/file/view"
import { questionTools } from "../../src/question/tools"

test("an explicit object Workspace root resolves absolute file references without an Environment", async () => {
  await using runtime = await testRuntime({
    register() {
      WorkspaceBlobs.register("fixture", {
        put: (hash, bytes) => Storage.writeBinary(["fixture", hash], bytes),
        get: (hash) => Storage.readBinary(["fixture", hash]),
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const workspace = await WorkspaceCatalog.create({
          scopeID: "home",
          backend: { provider: "objects", spec: { blobStore: "fixture", virtualRoot: "/workspace" } },
        })
        await using resources = await EnvironmentResources.resolve({
          scopeID: "home",
          workspaceID: workspace.id,
          needs: { workspace: true },
        })
        await EnvironmentResources.provide(resources, "virtual-files", async () => {
          expect(FileView.native()).toBe(false)
          expect(FileView.directory()).toBe("/workspace")
          await FileView.write("/workspace/result.txt", new TextEncoder().encode("object-backed result"), null)
          expect(await FileView.file("result.txt").text()).toBe("object-backed result")
          expect(await FileView.file("/workspace/result.txt").text()).toBe("object-backed result")
          expect(() => FileView.resolve("/etc/passwd")).toThrow()
          expect(() => FileView.resolve("/workspace/../outside")).toThrow()
          expect(() => FileView.resolve("../outside")).toThrow()
          expect(await Environment.list("home")).toEqual([])
        })
        // A selected live view changes physical location without changing the logical reference.
        EnvironmentResources.provide(
          { ...resources, kind: "execution", directory: "/isolated/mount" },
          "live-view",
          () => {
            expect(FileView.resolve("/workspace/result.txt")).toBe("/isolated/mount/result.txt")
            expect(FileView.relative("/workspace/result.txt")).toBe("result.txt")
          },
        )
      },
    }),
  )
})

test("invalid object roots fail before file or execution admission", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    for (const virtualRoot of ["relative", "/workspace/../outside", "/workspace\\file", "/workspace\u0000file"]) {
      const workspace = await WorkspaceCatalog.create({
        scopeID: "home",
        backend: { provider: "objects", spec: { blobStore: "fixture", virtualRoot } },
      })
      await expect(
        EnvironmentResources.resolve({
          scopeID: "home",
          workspaceID: workspace.id,
          needs: { workspace: true },
        }),
      ).rejects.toThrow()
    }
    expect(await Environment.list("home")).toEqual([])
  })
})

test("composing hosts can select the Question tool without a client product flag", async () => {
  expect(questionTools().map((tool) => tool.id)).toEqual(["question"])
})
