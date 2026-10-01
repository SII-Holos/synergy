import { expect, test } from "bun:test"
import path from "node:path"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs } from "@ericsanchezok/synergy-harness/workspace/content"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { storageTestBackends } from "../../../harness/test/support/storage-backends"
import { WorkspaceFileService as Files } from "../../src/workspace-file/service"
import { testRuntime } from "../support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

for (const backend of storageTestBackends())
  test(`${backend}: managed imports replay their operation and stream bounded chunks without preloading file content`, async () => {
    const reads: number[] = []
    let detached: ReadableStream | undefined
    await using runtime = await testRuntime({
      postgres: backend === "postgres" ? process.env.SYNERGY_TEST_POSTGRES_URL : undefined,
      register() {
        WorkspaceBlobs.register("transfer-fixture", {
          put: (hash, bytes) => Storage.writeBinary(["transfer-fixture", hash], bytes),
          async get(hash) {
            const bytes = await Storage.readBinary(["transfer-fixture", hash])
            reads.push(bytes.byteLength)
            return bytes
          },
        })
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          await using source = await tmpdir()
          const file = path.join(source.path, "source.bin")
          const bytes = Buffer.alloc(9 * 1024 * 1024, "q")
          await Bun.write(file, bytes)
          const workspace = await WorkspaceCatalog.create({
            scopeID: Scope.home().id,
            backend: { provider: "objects", spec: { blobStore: "transfer-fixture", virtualRoot: "/workspace" } },
          })
          await using resources = await EnvironmentResources.resolve({
            scopeID: workspace.scopeID,
            workspaceID: workspace.id,
            needs: { workspace: true },
          })
          await WorkspaceState.provide(
            { id: workspace.id, scopeID: workspace.scopeID, generation: workspace.binding.generation },
            () =>
              EnvironmentResources.provide(resources, "transfer-fixture", async () => {
                const input = {
                  from: file,
                  to: "uploads/source.bin",
                  operationID: "stable-import",
                  validateSource: async (target: string) => {
                    if (target !== file) throw new Error("Source changed")
                  },
                }
                const first = await Files.importEntry(input)
                const revision = (await WorkspaceCatalog.get(workspace.id, workspace.scopeID)).content?.revision
                await Files.importEntry(input)
                expect((await WorkspaceCatalog.get(workspace.id, workspace.scopeID)).content?.revision).toBe(revision)
                expect(first.node.type).toBe("file")
                await Bun.write(file, "different")
                await expect(Files.importEntry(input)).rejects.toThrow("different input")
                await Bun.write(file, bytes)
                reads.length = 0
                const served = await Files.serveFile({ path: "uploads/source.bin", maximumBytes: 512 * 1024 * 1024 })
                expect(reads.some((size) => size >= 1024 * 1024)).toBe(false)
                const reader = served.stream.getReader()
                expect((await reader.read()).value?.byteLength).toBe(4 * 1024 * 1024)
                expect(reads.filter((size) => size >= 1024 * 1024)).toHaveLength(1)
                await reader.cancel()
                reader.releaseLock()
                const complete = await Files.serveFile({ path: "uploads/source.bin" })
                expect(Buffer.from(await new Response(complete.stream).arrayBuffer())).toEqual(bytes)
                await expect(
                  Files.serveFile({ path: "uploads/source.bin", maximumBytes: 8 * 1024 * 1024 }),
                ).rejects.toThrow("too large")
                const controller = new AbortController()
                const cancelled = await Files.serveFile({ path: "uploads/source.bin", signal: controller.signal })
                controller.abort(new Error("Transfer stopped"))
                await expect(cancelled.stream.getReader().read()).rejects.toThrow("Transfer stopped")
                detached = (await Files.serveFile({ path: "uploads/source.bin" })).stream
              }),
          )
        },
      }),
    )
    expect(Buffer.from(await new Response(detached).arrayBuffer())).toEqual(Buffer.alloc(9 * 1024 * 1024, "q"))
  }, 30000)
