import { expect, test, spyOn } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { WorkspaceOperations } from "@ericsanchezok/synergy-harness/workspace/operations"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { FileTime } from "@ericsanchezok/synergy-harness/file/time"
import { ApplyPatchTool } from "../../src/tools/apply-patch"
import { FileView } from "../../src/file/view"
import { testRuntime } from "../support/runtime"

for (const reachable of [true, false])
  test(`selected patch retains one operation when its receipt is ${reachable ? "reconciled" : "unreachable"}`, async () => {
    await using runtime = await testRuntime({
      register() {
        WorkspaceBlobs.register("patch-receipt", {
          put: (hash, bytes) => Storage.writeBinary(["patch-receipt", hash], bytes),
          get: (hash) => Storage.readBinary(["patch-receipt", hash]),
        })
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const workspace = await WorkspaceCatalog.create({
            scopeID: Scope.home().id,
            backend: { provider: "objects", spec: { blobStore: "patch-receipt" } },
          })
          await using resources = await EnvironmentResources.resolve({
            scopeID: workspace.scopeID,
            workspaceID: workspace.id,
            needs: { workspace: true },
          })
          await WorkspaceState.provide(
            { id: workspace.id, scopeID: workspace.scopeID, generation: workspace.binding.generation },
            () =>
              EnvironmentResources.provide(resources, "patch-receipt", async () => {
                const original = WorkspaceOperations.write
                const ids: string[] = []
                using write = spyOn(WorkspaceOperations, "write").mockImplementation(async (input) => {
                  ids.push(input.id)
                  await original(input)
                  throw new Error("acknowledgement disconnected")
                })
                const originalGet = WorkspaceOperations.get
                using get = spyOn(WorkspaceOperations, "get").mockImplementation((...args) =>
                  reachable ? originalGet(...args) : Promise.reject(new Error("receipt unavailable")),
                )
                let captured: unknown
                await expect(
                  (await ApplyPatchTool.init()).execute(
                    {
                      patch: "*** Begin Patch\n*** Add File: one.txt\n+one\n*** Add File: two.txt\n+two\n*** End Patch",
                    },
                    {
                      resources,
                      sessionID: "receipt",
                      messageID: "message",
                      agent: "fixture",
                      abort: new AbortController().signal,
                      metadata() {},
                      async ask() {},
                      async captureResult(result) {
                        captured = result
                      },
                    },
                  ),
                ).rejects.toThrow("acknowledgement disconnected")
                expect(ids).toHaveLength(1)
                expect(captured).toMatchObject({
                  metadata: {
                    outcome: reachable ? "partial" : "unresolved",
                    sections: [
                      { source: "one.txt", operationID: ids[0], state: reachable ? "committed" : "unknown" },
                      { source: "two.txt", state: "not_started" },
                    ],
                  },
                })
                expect(await FileView.file("one.txt").text()).toBe("one\n")
                expect(await FileView.stat("two.txt")).toBeUndefined()
              }),
          )
        },
      }),
    )
  }, 30_000)

for (const live of [false, true])
  test(`patch uses selected ${live ? "live" : "dormant"} files across revisions`, async () => {
    await using runtime = await testRuntime({
      register() {
        WorkspaceBlobs.register("patch-fixture", {
          put: (hash, bytes) => Storage.writeBinary(["patch-fixture", hash], bytes),
          get: (hash) => Storage.readBinary(["patch-fixture", hash]),
        })
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const workspace = await WorkspaceCatalog.create({
            scopeID: Scope.home().id,
            backend: { provider: "objects", spec: { blobStore: "patch-fixture" } },
          })
          const selection = { scopeID: workspace.scopeID, workspaceID: workspace.id }
          for (const file of ["a.txt", "b.txt", "c.txt", "d.txt"])
            await WorkspaceContent.write(selection, {
              path: file,
              data: new TextEncoder().encode("old\n"),
              expectedVersion: null,
            })
          const environment = await Environment.bind({
            scopeID: workspace.scopeID,
            ownerID: "fixture",
            provider: "native",
            spec: {},
          })
          await using resources = await EnvironmentResources.resolve({
            ...selection,
            environmentID: environment.id,
            needs: live ? { execution: "exec" } : { workspace: true },
          })
          await WorkspaceState.provide(
            { id: workspace.id, scopeID: workspace.scopeID, generation: workspace.binding.generation },
            () =>
              EnvironmentResources.provide(resources, "patch-selected", async () => {
                const ctx = {
                  resources,
                  sessionID: "patch-selected",
                  messageID: "message",
                  callID: "patch",
                  agent: "fixture",
                  abort: new AbortController().signal,
                  metadata() {},
                  async ask() {
                    await FileView.write("unrelated.txt", new TextEncoder().encode("independent\n"), null)
                  },
                }
                for (const file of ["a.txt", "b.txt", "c.txt", "d.txt"])
                  FileTime.read(ctx.sessionID, FileView.resolve(file), await FileView.bytes(file))
                const result = await (
                  await ApplyPatchTool.init()
                ).execute(
                  {
                    patch:
                      "*** Begin Patch\n*** Add File: new/one.txt\n+one\n*** Add File: new/two.txt\n+two\n*** Update File: a.txt\n*** Move to: renamed.txt\n@@\n-old\n+new\n*** Delete File: b.txt\n*** Update File: c.txt\n*** Move to: moved.txt\n*** Delete File: d.txt\n*** End Patch",
                  },
                  ctx,
                )
                expect(result.metadata.outcome).toBe("applied")
                expect(result.metadata.sections.map((row) => row.state)).toEqual(Array(6).fill("committed"))
                expect(await FileView.file("renamed.txt").text()).toBe("new\n")
                expect(await FileView.file("moved.txt").text()).toBe("old\n")
                expect(await FileView.file("new/two.txt").text()).toBe("two\n")
                expect(await FileView.file("unrelated.txt").text()).toBe("independent\n")
                for (const file of ["a.txt", "b.txt", "c.txt", "d.txt"])
                  expect(await FileView.stat(file)).toBeUndefined()
                expect((await Environment.get(environment.id, workspace.scopeID)).state).toBe(live ? "ready" : "idle")
              }),
          )
          await resources[Symbol.asyncDispose]()
          await Environment.deallocate(environment.id, { scopeID: workspace.scopeID })
        },
      }),
    )
  }, 30_000)
