import { expect, test, spyOn } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { WorkspaceOperations } from "@ericsanchezok/synergy-harness/workspace/operations"
import { WorkspaceProtocol } from "@ericsanchezok/synergy-harness/workspace/protocol"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { FileTime } from "@ericsanchezok/synergy-harness/file/time"
import { ApplyPatchTool } from "../../src/tools/apply-patch"
import { FileView } from "../../src/file/view"
import { testRuntime } from "../support/runtime"

for (const phase of ["write", "delete"] as const)
  for (const reachable of [true, false])
    test(`selected Move ${phase} retains its effects when the receipt is ${reachable ? "reconciled" : "unreachable"}`, async () => {
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
                  await FileView.write("source.txt", new TextEncoder().encode("old\n"), null)
                  await FileView.write("target.txt", new TextEncoder().encode("target\n"), null)
                  for (const file of ["source.txt", "target.txt"])
                    FileTime.read("receipt", FileView.resolve(file), await FileView.bytes(file))
                  const originalWrite = WorkspaceOperations.write
                  const originalMutate = WorkspaceOperations.mutate
                  const ids: string[] = []
                  using write = spyOn(WorkspaceOperations, "write").mockImplementation(async (input) => {
                    ids.push(input.id)
                    const result = await originalWrite(input)
                    if (phase === "write") throw new Error("acknowledgement disconnected")
                    return result
                  })
                  using mutate = spyOn(WorkspaceOperations, "mutate").mockImplementation(async (input) => {
                    ids.push(input.id)
                    await originalMutate(input)
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
                        patch:
                          "*** Begin Patch\n*** Update File: source.txt\n*** Move to: target.txt\n@@\n-old\n+new\n*** Add File: later.txt\n+later\n*** End Patch",
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
                  expect(ids).toHaveLength(phase === "write" ? 1 : 2)
                  expect(new Set(ids).size).toBe(ids.length)
                  expect(captured).toMatchObject({
                    metadata: {
                      outcome: reachable ? "partial" : "unresolved",
                      sections: [
                        { source: "source.txt", operationID: ids.at(-1), state: reachable ? "committed" : "unknown" },
                        { source: "later.txt", state: "not_started" },
                      ],
                    },
                  })
                  expect(await FileView.file("target.txt").text()).toBe("new\n")
                  if (phase === "write") expect(await FileView.file("source.txt").text()).toBe("old\n")
                  else expect(await FileView.stat("source.txt")).toBeUndefined()
                  expect(await FileView.stat("later.txt")).toBeUndefined()
                  expect(captured).toMatchObject({
                    metadata: {
                      files:
                        phase === "delete"
                          ? reachable
                            ? [
                                { file: "target.txt", beforeBytes: 7, afterBytes: 4 },
                                { file: "source.txt", afterBytes: 0 },
                              ]
                            : [{ file: "target.txt", beforeBytes: 7, afterBytes: 4 }]
                          : reachable
                            ? [{ file: "target.txt", beforeBytes: 7, afterBytes: 4 }]
                            : [],
                    },
                  })
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
          await WorkspaceContent.write(selection, {
            path: "script.sh",
            data: new TextEncoder().encode("echo ready\n"),
            expectedVersion: null,
            mode: 0o751,
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
                let rejected: unknown
                let asked = false
                await EnvironmentResources.provide(resources, "patch-size-preflight", async () =>
                  expect(
                    (await ApplyPatchTool.init()).execute(
                      {
                        patch: `*** Begin Patch\n*** Add File: untouched/first.txt\n+first\n*** Add File: oversized.txt\n+${"é".repeat(WorkspaceProtocol.writeBytes / 2)}\n*** End Patch`,
                      },
                      {
                        ...ctx,
                        callID: "patch-size-preflight",
                        async ask() {
                          asked = true
                        },
                        async captureResult(result) {
                          rejected = result
                        },
                      },
                    ),
                  ).rejects.toThrow("exceeds the selected Workspace write limit"),
                )
                expect(asked).toBe(false)
                expect(rejected).toMatchObject({
                  metadata: {
                    outcome: "rejected",
                    files: [],
                    sections: [
                      { state: "not_started", operations: [], files: [] },
                      { state: "not_started", operations: [], files: [] },
                    ],
                  },
                })
                expect(await FileView.stat("untouched")).toBeUndefined()
                expect(await FileView.stat("oversized.txt")).toBeUndefined()
                for (const file of ["a.txt", "b.txt", "c.txt", "d.txt", "script.sh"])
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
                const replacing = await EnvironmentResources.provide(resources, "patch-overwrite", async () =>
                  (await ApplyPatchTool.init()).execute(
                    {
                      patch:
                        "*** Begin Patch\n*** Add File: new/one.txt\n+replaced\n*** Update File: renamed.txt\n*** Move to: new/two.txt\n@@\n-new\n+OVERWRITTEN\n*** Update File: moved.txt\n*** Move to: fresh/deep/last.txt\n*** Update File: script.sh\n*** Move to: executable/run.sh\n*** End Patch",
                    },
                    { ...ctx, callID: "patch-overwrite", async ask() {} },
                  ),
                )
                expect(replacing.metadata.outcome).toBe("applied")
                expect(await FileView.file("new/one.txt").text()).toBe("replaced\n")
                expect(await FileView.file("new/two.txt").text()).toBe("OVERWRITTEN\n")
                expect(await FileView.file("fresh/deep/last.txt").text()).toBe("old\n")
                expect(await FileView.stat("renamed.txt")).toBeUndefined()
                expect(await FileView.stat("moved.txt")).toBeUndefined()
                if (process.platform !== "win32") expect((await FileView.stat("executable/run.sh"))?.mode).toBe(0o751)
                expect(replacing.metadata.files.map((file) => file.file).sort()).toEqual([
                  "executable/run.sh",
                  "fresh/deep/last.txt",
                  "moved.txt",
                  "new/one.txt",
                  "new/two.txt",
                  "renamed.txt",
                  "script.sh",
                ])
                expect((await Environment.get(environment.id, workspace.scopeID)).state).toBe(live ? "ready" : "idle")
              }),
          )
          await resources[Symbol.asyncDispose]()
          await Environment.deallocate(environment.id, { scopeID: workspace.scopeID })
        },
      }),
    )
  }, 30_000)
