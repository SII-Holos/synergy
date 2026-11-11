import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceMounts } from "@ericsanchezok/synergy-harness/workspace/mount"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { NativeWorkspaceFiles } from "../../src/workspace/file-host"
import { registerNativeEnvironment } from "../../src/environment/native"

const begin = () => RuntimeMaintenance.begin({ purpose: "organization-backup", requestID: "mount-maintenance", actor: { kind: "system", subjectID: "operator", displayName: "Host operator", clientKind: "system", requestID: "mount-maintenance" } })
async function fixture(body: (input: WorkspaceMounts.Selection & { directory: string }) => Promise<void>) {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({ register() {
    RuntimeMaintenance.configure({ required: ["sessions"] })
    WorkspaceAccess.register(coordinator)
    registerNativeEnvironment({ coordinator })
  } })
  await runtime.run(async () => {
    const scope = await directory.scope()
    const workspace = await WorkspaceBinding.register(scope.id, directory.path)
    const environment = await Environment.bind({ scopeID: scope.id, ownerID: "fixture", provider: "native", spec: {} })
    await (await Environment.acquire(environment.id, { scopeID: scope.id, useID: "prepare-fixture", capabilities: ["files"] })).release()
    await body({ scopeID: scope.id, workspaceID: workspace.id, environmentID: environment.id, directory: directory.path, generation: workspace.binding.generation })
  })
}

for (const operation of ["attach", "detach"] as const) {
  test(`maintenance refuses a new ${operation} before native effects or a half-published mount transition`, async () => {
    await fixture(async (input) => {
      if (operation === "detach") await WorkspaceMounts.attach(input)
      const original = await WorkspaceCatalog.get(input.workspaceID, input.scopeID)
      const lease = await begin()
      try {
        await expect(WorkspaceMounts[operation](input)).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
        expect((await WorkspaceCatalog.get(input.workspaceID, input.scopeID)).activeMount).toEqual(original.activeMount)
        expect(await Environment.uses(input.environmentID)).toHaveLength(0)
        await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      } finally { await RuntimeMaintenance.release(lease) }
    })
  })
}

test("mount maintenance waits for the actual admitted native transition and cancellation preserves its original identity", async () => {
  await fixture(async (input) => {
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const mount = NativeWorkspaceFiles.prototype.mount
    let calls = 0
    using held = spyOn(NativeWorkspaceFiles.prototype, "mount").mockImplementation(async function (this: NativeWorkspaceFiles, raw) {
      calls++
      entered.resolve()
      await finish.promise
      return mount.call(this, raw)
    })
    const attaching = WorkspaceMounts.attach(input)
    await entered.promise
    const original = (await WorkspaceCatalog.get(input.workspaceID, input.scopeID)).activeMount!
    const lease = await begin()
    const cancellation = new AbortController()
    const draining = RuntimeMaintenance.drain(lease, { signal: cancellation.signal })
    let drained = false
    void draining.then(() => { drained = true }, () => {})
    try {
      await Bun.sleep(20)
      expect(drained).toBe(false)
      const reason = new Error("Stop waiting for the original native mount")
      cancellation.abort(reason)
      await expect(draining).rejects.toBe(reason)
      finish.resolve()
      const result = await attaching
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      expect(result.activeMount).toMatchObject({ id: original.id, generation: original.generation, target: original.target, state: "active" })
      expect(calls).toBe(1)
      expect(await Environment.uses(input.environmentID)).toHaveLength(0)
    } finally {
      cancellation.abort()
      finish.resolve()
      await attaching
      await RuntimeMaintenance.release(lease)
    }
  })
})

test("an orphaned preparing record cannot authorize materialization without its original native receipt", async () => {
  await fixture(async (input) => {
    const missing = new Error("The native mount was never acknowledged")
    using fault = spyOn(NativeWorkspaceFiles.prototype, "mount").mockRejectedValueOnce(missing)
    await expect(WorkspaceMounts.attach(input)).rejects.toBe(missing)
    fault.mockRestore()
    const before = (await WorkspaceCatalog.get(input.workspaceID, input.scopeID)).activeMount!
    expect(before.state).toBe("preparing")
    await expect(WorkspaceMounts.attach(input)).rejects.toThrow("original native")
    expect((await WorkspaceCatalog.get(input.workspaceID, input.scopeID)).activeMount).toEqual(before)
    const lease = await begin()
    await expect(RuntimeMaintenance.drain(lease)).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
    expect((await RuntimeMaintenance.status())?.phase).toBe("draining")
  })
})

test("maintenance reconciles a committed native mount with a lost acknowledgement without replaying materialization", async () => {
  await fixture(async (input) => {
    const lost = new Error("The original native mount response was lost")
    const mount = NativeWorkspaceFiles.prototype.mount
    using fault = spyOn(NativeWorkspaceFiles.prototype, "mount").mockImplementationOnce(async function (this: NativeWorkspaceFiles, raw) {
      await mount.call(this, raw)
      throw lost
    })
    await expect(WorkspaceMounts.attach(input)).rejects.toBe(lost)
    fault.mockRestore()
    let repeated = 0
    using replay = spyOn(NativeWorkspaceFiles.prototype, "mount").mockImplementation(async function (this: NativeWorkspaceFiles, raw) { repeated++; return mount.call(this, raw) })
    const before = (await WorkspaceCatalog.get(input.workspaceID, input.scopeID)).activeMount!
    const lease = await begin()
    try {
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      const after = (await WorkspaceCatalog.get(input.workspaceID, input.scopeID)).activeMount!
      expect(after).toMatchObject({ id: before.id, target: before.target, generation: before.generation, state: "active" })
      expect(repeated).toBe(0)
      expect(await Environment.uses(input.environmentID)).toHaveLength(0)
    } finally { await RuntimeMaintenance.release(lease) }
  })
})

test("ordinary attach cannot replace a pending native save with an active view", async () => {
  await fixture(async (input) => {
    const info = await WorkspaceMounts.attach(input)
    const saving = { ...info, activeMount: { ...info.activeMount!, state: "saving" as const } }
    await Storage.write(["workspace", info.id], saving)
    await expect(WorkspaceMounts.attach(input)).rejects.toBeInstanceOf(WorkspaceCatalog.Unavailable)
    expect((await WorkspaceCatalog.get(info.id, info.scopeID)).activeMount).toEqual(saving.activeMount)
  })
})

test("a missing native mount index cannot certify an otherwise active canonical Workspace", async () => {
  await fixture(async (input) => {
    await WorkspaceMounts.attach(input)
    await Storage.remove(["workspace_environment", input.environmentID, input.workspaceID])
    const lease = await begin()
    await expect(RuntimeMaintenance.drain(lease)).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
    expect((await RuntimeMaintenance.status())?.phase).toBe("draining")
  })
})
