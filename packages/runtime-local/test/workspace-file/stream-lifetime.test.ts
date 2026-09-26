import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { FileMutation } from "../../src/file/mutation"
import { WorkspaceFileService } from "../../src/workspace-file/service"
import { testRuntime } from "../support/runtime"

for (const end of ["read", "cancel", "dispose", "abort", "truncate"] as const) {
  test(`a raw file stream retains its binding beyond the request and releases on ${end}`, async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      await using tmp = await tmpdir()
      const scope = await tmp.scope()
      const record = await WorkspaceBinding.register(scope.id, tmp.path)
      const workspace = WorkspaceCatalog.projection(record)
      const bytes = Buffer.alloc(256 * 1024, 42)
      await Bun.write(path.join(tmp.path, "bytes.bin"), bytes)
      const controller = new AbortController()
      const result = await ScopeContext.provide({
        scope,
        workspace,
        fn: () =>
          WorkspaceAccess.task({ workspace }, () =>
            WorkspaceFileService.serveFile({ path: "bytes.bin", signal: controller.signal }),
          ),
      })
      try {
        await expect(
          WorkspaceBinding.setSharing(record.id, {
            scopeID: scope.id,
            expectedRevision: record.revision,
            workspaceIDs: [],
          }),
        ).rejects.toThrow("busy")
        if (end === "read") {
          const output = await new Response(result.stream).arrayBuffer()
          expect(Buffer.from(output).equals(bytes)).toBe(true)
        } else if (end === "cancel") await result.stream.cancel()
        else if (end === "dispose") {
          await WorkspaceState.disposeWorkspace(record.id)
          await expect(result.stream.getReader().read()).rejects.toThrow()
        } else {
          const reader = result.stream.getReader()
          expect((await reader.read()).value?.byteLength).toBe(64 * 1024)
          if (end === "abort") controller.abort(new Error("Caller disconnected"))
          else await fs.truncate(path.join(tmp.path, "bytes.bin"), 0)
          await expect(reader.read()).rejects.toThrow()
          reader.releaseLock()
        }
        const updated = await WorkspaceBinding.setSharing(record.id, {
          scopeID: scope.id,
          expectedRevision: record.revision,
          workspaceIDs: [],
        })
        expect(updated.revision).toBe(record.revision + 1)
      } finally {
        await result.stream.cancel().catch(() => {})
      }
    })
  }, 10000)
}

test("a raw stream reads its captured file after an atomic writer replaces the path", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const target = path.join(tmp.path, "index.html")
        const original = "original".repeat(50000)
        await Bun.write(target, original)
        const result = await WorkspaceFileService.serveFile({ path: "index.html" })
        await FileMutation.write({ path: target, content: "replacement" })
        const received = await new Response(result.stream).text()
        expect(received.length).toBe(original.length)
        expect(Bun.CryptoHasher.hash("sha256", received, "hex")).toBe(Bun.CryptoHasher.hash("sha256", original, "hex"))
        expect(await Bun.file(target).text()).toBe("replacement")
      },
    })
  })
})

test("an empty raw file completes and releases without a data chunk", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()
    await ScopeContext.provide({
      scope,
      async fn() {
        await Bun.write(path.join(tmp.path, "empty.txt"), "")
        const result = await WorkspaceFileService.serveFile({ path: "empty.txt" })
        expect(await new Response(result.stream).text()).toBe("")
        const workspace = ScopeContext.current.workspace!
        const record = await WorkspaceCatalog.get(workspace.id!, scope.id)
        expect(
          (
            await WorkspaceBinding.setSharing(record.id, {
              scopeID: scope.id,
              expectedRevision: record.revision,
              workspaceIDs: [],
            })
          ).revision,
        ).toBe(record.revision + 1)
      },
    })
  })
})
