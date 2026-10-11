import { expect, test } from "bun:test"
import path from "node:path"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { registerNativeEnvironment } from "../../src/environment/native"

test.each(["execution", "files", "cancelled", "failed"] as const)(
  "concurrent %s admission preserves the owned Workspace attachment",
  async (mode) => {
    await using tmp = await tmpdir()
    const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let paused = false
    let block = false
    let reads = 0
    await using runtime = await testRuntime({
      register() {
        WorkspaceAccess.register(coordinator)
        registerNativeEnvironment({ coordinator })
        WorkspaceBlobs.register("fixture", {
          put: (hash, bytes) => Storage.writeBinary(["fixture", hash], bytes),
          async get(hash) {
            reads++
            if (block && !paused) {
              paused = true
              entered.resolve()
              await release.promise
              if (mode === "failed") throw new Error("fixture materialization failed")
            }
            return Storage.readBinary(["fixture", hash])
          },
        })
      },
    })
    await runtime.run(async () => {
      const environment = await Environment.bind({ scopeID: "scope", ownerID: "owner", provider: "native", spec: {} })
      const workspace = await WorkspaceCatalog.create({
        scopeID: "scope",
        backend: { provider: "objects", spec: { blobStore: "fixture" } },
      })
      const selection = { scopeID: "scope", workspaceID: workspace.id, environmentID: environment.id }
      await WorkspaceContent.write(selection, {
        path: "input.txt",
        data: new TextEncoder().encode("authoritative bytes"),
        expectedVersion: null,
      })
      block = true
      const first = EnvironmentResources.resolve({ ...selection, needs: { execution: "exec" } })
      void first.catch(() => {})
      await entered.promise
      expect((await WorkspaceCatalog.get(workspace.id, "scope")).activeMount?.state).toBe("preparing")
      const controller = new AbortController()
      const second = EnvironmentResources.resolve({
        ...selection,
        signal: controller.signal,
        needs: mode === "files" ? { workspace: true } : { execution: "exec" },
      })
      void second.catch(() => {})
      try {
        const other = await Environment.bind({ scopeID: "scope", ownerID: "other", provider: "native", spec: {} })
        await expect(
          EnvironmentResources.resolve({ ...selection, environmentID: other.id, needs: { execution: "exec" } }),
        ).rejects.toMatchObject({ name: "WorkspaceUnavailable" })
        expect((await Environment.get(other.id, "scope")).allocation).toBeUndefined()
        if (mode === "cancelled") {
          const reason = new Error("cancel only this waiter")
          controller.abort(reason)
          await expect(second).rejects.toBe(reason)
          expect((await WorkspaceCatalog.get(workspace.id, "scope")).activeMount?.state).toBe("preparing")
        }
      } finally {
        release.resolve()
      }
      if (mode === "failed") {
        await expect(first).rejects.toThrow("fixture materialization failed")
        await expect(second).rejects.toThrow("fixture materialization failed")
        const before = reads
        await expect(
          EnvironmentResources.resolve({ ...selection, needs: { execution: "exec" } }),
        ).rejects.toMatchObject({
          name: "WorkspaceUnavailable",
        })
        expect(reads).toBe(before)
        return
      }
      await using one = await first
      expect(one.workspace?.activeMount?.state).toBe("active")
      if (mode !== "cancelled") {
        await using two = await second
        expect(two.directory).toBe(one.directory)
        expect(two.workspace?.activeMount).toEqual(one.workspace?.activeMount)
        expect(await Bun.file(path.join(two.directory!, "input.txt")).text()).toBe("authoritative bytes")
      }
      await one.release()
      expect(await Environment.uses(environment.id)).toHaveLength(0)
      await Environment.deallocate(environment.id, { scopeID: "scope" })
      expect((await WorkspaceCatalog.get(workspace.id, "scope")).activeMount).toBeUndefined()
    })
  },
  20_000,
)
