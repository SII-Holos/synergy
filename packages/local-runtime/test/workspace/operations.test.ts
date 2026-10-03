import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceMounts } from "@ericsanchezok/synergy-harness/workspace/mount"
import { WorkspaceOperations } from "@ericsanchezok/synergy-harness/workspace/operations"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { registerNativeEnvironment } from "../../src/environment/native"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"

test("confirmed rebinding releases an obsolete directory mount after active users finish", async () => {
  await using tmp = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      WorkspaceAccess.register(coordinator)
      registerNativeEnvironment({ coordinator })
    },
  })
  await runtime.run(async () => {
    const scope = await tmp.scope()
    const root = path.join(tmp.path, "folder")
    await fs.mkdir(root)
    await Bun.write(path.join(root, "file"), "original")
    const workspace = await WorkspaceBinding.register(scope.id, root)
    const environment = await Environment.bind({ scopeID: scope.id, ownerID: "owner", provider: "native", spec: {} })
    const mounted = await WorkspaceMounts.attach({
      scopeID: scope.id,
      workspaceID: workspace.id,
      environmentID: environment.id,
      directory: root,
    })
    const files = await WorkspaceMounts.connect(mounted)
    await fs.rename(root, root + "-previous")
    await fs.mkdir(root)
    await Bun.write(path.join(root, "file"), "confirmed")
    await expect(WorkspaceBinding.validate(workspace.id, scope.id)).rejects.toMatchObject({
      name: "WorkspaceUnavailable",
    })
    await expect(files.inspect(WorkspaceMounts.reference(mounted))).rejects.toThrow("changed")
    const held = await Environment.acquire(environment.id, {
      scopeID: scope.id,
      useID: "active",
      kind: "admission",
      capabilities: ["files"],
    })
    try {
      await expect(
        WorkspaceBinding.rebind(workspace.id, { scopeID: scope.id, expectedRevision: mounted.revision, path: root }),
      ).rejects.toMatchObject({ name: "EnvironmentBusy" })
    } finally {
      await held.release()
    }
    const rebound = await WorkspaceBinding.rebind(workspace.id, {
      scopeID: scope.id,
      expectedRevision: mounted.revision,
      path: root,
    })
    expect(rebound.id).toBe(workspace.id)
    expect(rebound.binding.generation).toBe(workspace.binding.generation + 1)
    expect(rebound.activeMount).toBeUndefined()
    expect(await Environment.uses(environment.id)).toHaveLength(0)
    expect(await WorkspaceBinding.validate(workspace.id, scope.id)).toMatchObject({
      generation: rebound.binding.generation,
    })
    expect(await Bun.file(path.join(root, "file")).text()).toBe("confirmed")
    expect(await Bun.file(path.join(root + "-previous", "file")).text()).toBe("original")
  })
}, 30_000)

test("file mutations retain their allocation until publication and recover without repeating a write", async () => {
  await using tmp = await tmpdir()
  let failUpload = false
  const coordinator = new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      WorkspaceAccess.register(coordinator)
      registerNativeEnvironment({ coordinator })
      WorkspaceBlobs.register("fixture", {
        async put(hash, bytes) {
          if (failUpload) throw new Error("upload interrupted")
          await Storage.writeBinary(["fixture", hash], bytes)
        },
        get: (hash) => Storage.readBinary(["fixture", hash]),
      })
    },
  })
  await runtime.run(async () => {
    const scopeID = "scope"
    const environment = await Environment.bind({ scopeID, ownerID: "owner", provider: "native", spec: {} })
    const workspace = await WorkspaceCatalog.create({
      scopeID,
      backend: { provider: "objects", spec: { blobStore: "fixture" } },
    })
    const mounted = await WorkspaceMounts.attach({ scopeID, workspaceID: workspace.id, environmentID: environment.id })
    const files = await WorkspaceMounts.connect(mounted)
    const original = files.write.bind(files)
    let writes = 0
    files.write = async (input) => {
      writes++
      const result = await original(input)
      throw new Error(`acknowledgement lost: ${result.id}`)
    }
    const input = {
      id: "edit",
      scopeID,
      workspaceID: workspace.id,
      path: "file",
      data: Buffer.from("once"),
      expectedVersion: null,
    }
    await expect(WorkspaceOperations.write(input)).rejects.toThrow("acknowledgement lost")
    expect((await WorkspaceOperations.get(input.id, scopeID)).state).toBe("submitted")
    expect(await Environment.uses(environment.id)).toHaveLength(1)
    const inspect = files.checkpointStatus.bind(files)
    files.checkpointStatus = async () => undefined
    expect((await WorkspaceOperations.reconcile(input.id, scopeID)).state).toBe("unknown")
    await expect(WorkspaceOperations.write(input)).rejects.toThrow("unknown")
    expect(writes).toBe(1)
    expect(await Environment.uses(environment.id)).toHaveLength(1)
    files.checkpointStatus = inspect
    failUpload = true
    await expect(WorkspaceOperations.reconcile(input.id, scopeID)).rejects.toThrow("upload interrupted")
    expect((await WorkspaceOperations.get(input.id, scopeID)).state).toBe("unsaved")
    await expect(Environment.deallocate(environment.id, { scopeID })).rejects.toMatchObject({ name: "EnvironmentBusy" })
    failUpload = false
    await WorkspaceOperations.recover()
    expect((await WorkspaceOperations.get(input.id, scopeID)).state).toBe("completed")
    expect(writes).toBe(1)
    await expect(WorkspaceOperations.write({ ...input, data: Buffer.from("different") })).rejects.toThrow(
      "different input",
    )
    await WorkspaceOperations.write(input)
    expect(writes).toBe(1)
    expect(await Environment.uses(environment.id)).toHaveLength(0)
    await Environment.deallocate(environment.id, { scopeID })
    expect(new TextDecoder().decode(await WorkspaceContent.read({ scopeID, workspaceID: workspace.id }, "file"))).toBe(
      "once",
    )
  })
}, 30_000)
