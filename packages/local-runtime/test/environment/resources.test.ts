import { expect, test } from "bun:test"
import path from "node:path"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { WorkspaceCatalog, WorkspaceBinding } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { registerNativeEnvironment } from "../../src/environment/native"

test("native directory and object Workspaces resolve through one lazy execution selection", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      WorkspaceAccess.register(coordinator)
      registerNativeEnvironment({ coordinator })
      WorkspaceBlobs.register("fixture", {
        put: (hash, bytes) => Storage.writeBinary(["fixture", hash], bytes),
        get: (hash) => Storage.readBinary(["fixture", hash]),
      })
    },
  })
  await runtime.run(async () => {
    const scope = await tmp.scope()
    const directory = await WorkspaceBinding.register(scope.id, tmp.path)
    const object = await WorkspaceCatalog.create({
      scopeID: scope.id,
      backend: { provider: "objects", spec: { blobStore: "fixture" } },
    })
    const environment = await Environment.bind({ scopeID: scope.id, ownerID: "owner", provider: "native", spec: {} })
    await using files = await EnvironmentResources.resolve({
      scopeID: scope.id,
      workspaceID: directory.id,
      environmentID: environment.id,
      needs: { workspace: true },
    })
    expect(files.kind).toBe("native")
    expect((await Environment.get(environment.id, scope.id)).state).toBe("idle")
    {
      await using execution = await EnvironmentResources.resolve({
        scopeID: scope.id,
        workspaceID: object.id,
        environmentID: environment.id,
        needs: { execution: "exec" },
      })
      expect(execution.directory).toBe(execution.workspace?.activeMount?.path)
      expect(execution.runtime?.platform).toBe(process.platform)
      expect(await Environment.uses(environment.id)).toHaveLength(1)
      await expect(Environment.deallocate(environment.id, { scopeID: scope.id })).rejects.toMatchObject({
        name: "EnvironmentBusy",
      })
    }
    expect(await Environment.uses(environment.id)).toHaveLength(0)
    await Environment.deallocate(environment.id, { scopeID: scope.id })
    expect((await WorkspaceCatalog.get(object.id, scope.id)).activeMount).toBeUndefined()
    await WorkspaceContent.write(
      { workspaceID: object.id, scopeID: scope.id },
      { path: "file.txt", data: new TextEncoder().encode("saved"), expectedVersion: null },
    )
  })
}, 30_000)
