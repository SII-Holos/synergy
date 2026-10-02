import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { NativeExecutor } from "../../src/environment/native-executor"
import { ExecutionHost } from "../../src/environment/host"
import { RemoteExecutor } from "../../src/environment/remote-executor"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { testRuntime } from "../support/runtime"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceMounts } from "@ericsanchezok/synergy-harness/workspace/mount"
import { WorkspaceEvents } from "@ericsanchezok/synergy-harness/workspace/events"
import { WorkspaceState } from "@ericsanchezok/synergy-harness/workspace/state"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { ScopeRuntime } from "@ericsanchezok/synergy-harness/scope/runtime"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { FileWatcher } from "../../src/file/watcher"

test("Workspace observation reports nested native writes through the execution transport and fences detached views", async () => {
  await using tmp = await tmpdir()
  const target = { environmentID: "environment", allocationID: "allocation", generation: 1 }
  await using executor = await NativeExecutor.open({
    target,
    directory: path.join(tmp.path, "receipts"),
    coordinator: new WorkspaceCoordinator({ directory: path.join(tmp.path, "claims") }),
  })
  const token = "test-token-with-at-least-thirty-two-bytes"
  await using host = ExecutionHost.listen({ executor, target, token, listen: { hostname: "127.0.0.1", port: 0 } })
  const remote = new RemoteExecutor({ url: host.url, target, token })
  const root = path.join(tmp.path, "workspace")
  await Bun.write(path.join(root, "nested", "file"), "before")
  const mount = await remote.files.mount({
    id: "mount",
    workspaceID: "workspace",
    generation: 1,
    source: { kind: "directory", path: root },
    readOnly: false,
  })
  const before = await remote.files.observe(mount)
  await Bun.write(path.join(root, "nested", "file"), "after")
  const deadline = Date.now() + 5000
  let after = await remote.files.observe(mount)
  while (after.version === before.version) {
    if (Date.now() > deadline) throw new Error("Workspace observation did not change")
    await Bun.sleep(10)
    after = await remote.files.observe(mount)
  }
  expect(after.epoch).toBe(before.epoch)
  expect(after.version).toBeGreaterThan(before.version)
  expect(
    Buffer.from(
      (await remote.files.read({ mount, path: "nested/file", offset: 0, maximumBytes: 128 })).data,
      "base64",
    ).toString(),
  ).toBe("after")
  await remote.files.detach(mount)
  await expect(remote.files.observe(mount)).rejects.toThrow()
}, 10000)

test("logical Workspace observation starts through tools, follows live views, and never allocates compute", async () => {
  await using runtime = await testRuntime({
    env: { SYNERGY_DISABLE_FILEWATCHER: "false" },
    register() {
      WorkspaceBlobs.register("fixture", {
        put: (hash, bytes) => Storage.writeBinary(["test_blobs", hash], bytes),
        get: (hash) => Storage.readBinary(["test_blobs", hash]),
      })
    },
  })
  await runtime.run(async () => {
    await using tmp = await tmpdir()
    const scope = await tmp.scope()
    const workspace = await WorkspaceCatalog.create({
      scopeID: scope.id,
      backend: { provider: "objects", spec: { blobStore: "fixture" } },
    })
    const environment = await Environment.bind({ scopeID: scope.id, ownerID: "owner", provider: "native", spec: {} })
    const selection = { scopeID: scope.id, workspaceID: workspace.id, environmentID: environment.id }
    let count = 0
    const wait = async (before: number) => {
      const deadline = Date.now() + 5000
      while (count <= before) {
        if (Date.now() > deadline) throw new Error("Workspace view did not resync")
        await Bun.sleep(10)
      }
    }
    await ScopeContext.provide({
      scope,
      workspace: null,
      fn: async () => {
        await using resources = await EnvironmentResources.resolve({ ...selection, needs: { workspace: true } })
        const unsubscribe = WorkspaceState.provide({ id: workspace.id, generation: 1, scopeID: scope.id }, () =>
          WorkspaceEvents.subscribe(FileWatcher.Event.Updated, (event) => {
            expect(event.properties.workspaceID).toBe(workspace.id)
            if (event.properties.resync) count++
          }),
        )
        try {
          await Tool.withWorkspace(false, { resources }, async () => {})
          expect(count).toBe(1)
          expect((await Environment.get(environment.id, scope.id)).allocation).toBeUndefined()
          let previous = count
          await WorkspaceContent.write(selection, { path: "file", data: Buffer.from("saved"), expectedVersion: null })
          await wait(previous)
          previous = count
          const active = await WorkspaceMounts.attach(selection)
          await wait(previous)
          previous = count
          await Bun.write(path.join(active.activeMount!.path, "file"), "changed on execution host")
          await wait(previous)
          expect(await Environment.uses(environment.id)).toHaveLength(0)
          previous = count
          await Environment.deallocate(environment.id, { scopeID: scope.id })
          await wait(previous)
          await Bun.sleep(1100)
          expect((await Environment.get(environment.id, scope.id)).state).toBe("idle")
          expect((await Environment.get(environment.id, scope.id)).allocation).toBeUndefined()
          expect(Buffer.from(await WorkspaceContent.read(selection, "file")).toString()).toBe(
            "changed on execution host",
          )
        } finally {
          unsubscribe()
          await ScopeRuntime.dispose(scope.id)
        }
      },
    })
  })
}, 20000)
