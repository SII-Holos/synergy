import { expect, spyOn, test } from "bun:test"
import path from "node:path"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceMounts } from "@ericsanchezok/synergy-harness/workspace/mount"
import { testEnvironmentRuntime as testRuntime } from "@ericsanchezok/synergy-harness/test/support/environment-origin"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { NativeWorkspaceFiles } from "../../src/workspace/file-host"
import { registerNativeEnvironment } from "../../src/environment/native"
import { WorkspaceBlobs, WorkspaceContent } from "@ericsanchezok/synergy-harness/workspace/content"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { EnvironmentProviders } from "@ericsanchezok/synergy-harness/environment/provider"

const begin = () =>
  RuntimeMaintenance.begin({
    purpose: "organization-backup",
    requestID: "mount-maintenance",
    actor: {
      kind: "system",
      subjectID: "operator",
      displayName: "Host operator",
      clientKind: "system",
      requestID: "mount-maintenance",
    },
  })
async function fixture(body: (input: WorkspaceMounts.Selection & { directory: string }) => Promise<void>) {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      RuntimeMaintenance.configure({ required: ["sessions"] })
      WorkspaceAccess.register(coordinator)
      registerNativeEnvironment({ coordinator })
    },
  })
  await runtime.run(async () => {
    const scope = await directory.scope()
    const workspace = await WorkspaceBinding.register(scope.id, directory.path)
    const environment = await Environment.bind({ scopeID: scope.id, ownerID: "fixture", provider: "native", spec: {} })
    await (
      await Environment.acquire(environment.id, {
        scopeID: scope.id,
        useID: "prepare-fixture",
        ownership: runtime.origin("prepare-fixture"),
        capabilities: ["files"],
      })
    ).release()
    await body({
      scopeID: scope.id,
      workspaceID: workspace.id,
      environmentID: environment.id,
      directory: directory.path,
      generation: workspace.binding.generation,
    })
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
      } finally {
        await RuntimeMaintenance.release(lease)
      }
    })
  })
}

test("mount maintenance waits for the actual admitted native transition and cancellation preserves its original identity", async () => {
  await fixture(async (input) => {
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const mount = NativeWorkspaceFiles.prototype.mount
    let calls = 0
    using held = spyOn(NativeWorkspaceFiles.prototype, "mount").mockImplementation(async function (
      this: NativeWorkspaceFiles,
      raw,
    ) {
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
    void draining.then(
      () => {
        drained = true
      },
      () => {},
    )
    try {
      await Bun.sleep(20)
      expect(drained).toBe(false)
      const reason = new Error("Stop waiting for the original native mount")
      cancellation.abort(reason)
      await expect(draining).rejects.toBe(reason)
      finish.resolve()
      const result = await attaching
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      expect(result.activeMount).toMatchObject({
        id: original.id,
        generation: original.generation,
        target: original.target,
        state: "active",
      })
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
    using fault = spyOn(NativeWorkspaceFiles.prototype, "mount").mockImplementationOnce(async function (
      this: NativeWorkspaceFiles,
      raw,
    ) {
      await mount.call(this, raw)
      throw lost
    })
    await expect(WorkspaceMounts.attach(input)).rejects.toBe(lost)
    fault.mockRestore()
    let repeated = 0
    using replay = spyOn(NativeWorkspaceFiles.prototype, "mount").mockImplementation(async function (
      this: NativeWorkspaceFiles,
      raw,
    ) {
      repeated++
      return mount.call(this, raw)
    })
    const before = (await WorkspaceCatalog.get(input.workspaceID, input.scopeID)).activeMount!
    const lease = await begin()
    try {
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      const after = (await WorkspaceCatalog.get(input.workspaceID, input.scopeID)).activeMount!
      expect(after).toMatchObject({
        id: before.id,
        target: before.target,
        generation: before.generation,
        state: "active",
      })
      expect(repeated).toBe(0)
      expect(await Environment.uses(input.environmentID)).toHaveLength(0)
    } finally {
      await RuntimeMaintenance.release(lease)
    }
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

test("maintenance refuses a new Environment deallocation before publishing a release intent or detaching its view", async () => {
  await fixture(async (input) => {
    const original = await WorkspaceMounts.attach(input)
    const environment = await Environment.get(input.environmentID, input.scopeID)
    let detached = 0
    const detach = NativeWorkspaceFiles.prototype.detach
    using observed = spyOn(NativeWorkspaceFiles.prototype, "detach").mockImplementation(async function (
      this: NativeWorkspaceFiles,
      reference,
    ) {
      detached++
      return detach.call(this, reference)
    })
    const lease = await begin()
    await expect(
      Environment.deallocate(environment.id, { scopeID: input.scopeID, expectedGeneration: environment.generation }),
    ).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
    expect(await Environment.get(environment.id, input.scopeID)).toEqual(environment)
    expect((await WorkspaceCatalog.get(input.workspaceID, input.scopeID)).activeMount).toEqual(original.activeMount)
    expect(detached).toBe(0)
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    await RuntimeMaintenance.release(lease)
  })
}, 15_000)

test("an accepted Environment release keeps its native ownership through a later maintenance hold", async () => {
  await fixture(async (input) => {
    const original = await WorkspaceMounts.attach(input)
    const environment = await Environment.get(input.environmentID, input.scopeID)
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const detach = NativeWorkspaceFiles.prototype.detach
    using held = spyOn(NativeWorkspaceFiles.prototype, "detach").mockImplementationOnce(async function (
      this: NativeWorkspaceFiles,
      reference,
    ) {
      entered.resolve()
      await finish.promise
      return detach.call(this, reference)
    })
    const releasing = Environment.deallocate(environment.id, {
      scopeID: input.scopeID,
      expectedGeneration: environment.generation,
    })
    void releasing.catch(() => {})
    await entered.promise
    await expect(coordinatorClaim(input.directory)).rejects.toBeInstanceOf(WorkspaceAccess.BusyError)
    const lease = await begin()
    expect((await WorkspaceCatalog.get(input.workspaceID, input.scopeID)).activeMount).toEqual(original.activeMount)
    await expect(RuntimeMaintenance.drain(lease)).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
    finish.resolve()
    const recovered = await releasing
    expect(recovered.state).toBe("idle")
    expect(recovered.generation).toBe(environment.generation)
    expect(recovered.allocation).toBeUndefined()
    expect((await WorkspaceCatalog.get(input.workspaceID, input.scopeID)).activeMount).toBeUndefined()
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    await RuntimeMaintenance.release(lease)
  })
}, 15_000)

async function coordinatorClaim(directory: string) {
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory, "claims") })
  const lease = await coordinator.acquire({
    id: "foreign-release-writer",
    owner: "another-runtime",
    ancestors: [],
    roots: [directory],
    kind: "exclusive",
    timeoutMs: 30,
  })
  await lease.release()
}

test("a maintenance hold after native reservation still rejects an unpublished Environment release", async () => {
  await fixture(async (input) => {
    const workspace = await WorkspaceMounts.attach(input)
    const environment = await Environment.get(input.environmentID, input.scopeID)
    const provider = EnvironmentProviders.get("native")
    const reserve = provider.withDeallocation!
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    using held = spyOn(provider, "withDeallocation").mockImplementation(async (info, release) =>
      reserve(info, async () => {
        entered.resolve()
        await finish.promise
        return release()
      }),
    )
    const releasing = Environment.deallocate(environment.id, { scopeID: input.scopeID })
    void releasing.catch(() => {})
    await Promise.race([
      entered.promise,
      releasing.then(() => {
        throw new Error("Release completed before the reservation barrier")
      }),
    ])
    const lease = await begin()
    finish.resolve()
    await expect(releasing).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
    expect(await Environment.get(environment.id, input.scopeID)).toEqual(environment)
    expect((await WorkspaceCatalog.get(input.workspaceID, input.scopeID)).activeMount).toEqual(workspace.activeMount)
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    await RuntimeMaintenance.release(lease)
  })
}, 15_000)

test("an admitted object Workspace release saves final bytes and detaches under its original native claim", async () => {
  await using directory = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(directory.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      RuntimeMaintenance.configure({ required: ["sessions"] })
      WorkspaceAccess.register(coordinator)
      registerNativeEnvironment({ coordinator })
      WorkspaceBlobs.register("fixture", {
        put: (hash, bytes) => Storage.writeBinary(["fixture", hash], bytes),
        get: (hash, size) => Storage.readBinary(["fixture", hash], { maxBytes: size }),
      })
    },
  })
  await runtime.run(async () => {
    const scope = await directory.scope()
    const environment = await Environment.bind({ scopeID: scope.id, ownerID: "objects", provider: "native", spec: {} })
    const workspace = await WorkspaceCatalog.create({
      scopeID: scope.id,
      backend: { provider: "objects", spec: { blobStore: "fixture" } },
    })
    const selection = { scopeID: scope.id, workspaceID: workspace.id, environmentID: environment.id }
    await WorkspaceContent.write(selection, {
      path: "file.txt",
      data: new TextEncoder().encode("before"),
      expectedVersion: null,
    })
    const resources = await EnvironmentResources.resolve({
      ...selection,
      origin: runtime.origin("object-release"),
      needs: { execution: "exec" },
    })
    await Bun.write(path.join(resources.directory!, "file.txt"), "last accepted bytes 你好")
    await resources.release()
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const checkpoint = NativeWorkspaceFiles.prototype.checkpoint
    using held = spyOn(NativeWorkspaceFiles.prototype, "checkpoint").mockImplementationOnce(async function (
      this: NativeWorkspaceFiles,
      input,
    ) {
      entered.resolve()
      await finish.promise
      return checkpoint.call(this, input)
    })
    const releasing = Environment.deallocate(environment.id, { scopeID: scope.id })
    void releasing.catch(() => {})
    await entered.promise
    const lease = await begin()
    await expect(RuntimeMaintenance.drain(lease)).rejects.toBeInstanceOf(RuntimeMaintenance.Blocked)
    finish.resolve()
    expect((await releasing).state).toBe("idle")
    expect((await WorkspaceCatalog.get(workspace.id, scope.id)).activeMount).toBeUndefined()
    const file = await WorkspaceContent.read(selection, "file.txt")
    expect(new TextDecoder().decode(file)).toBe("last accepted bytes 你好")
    await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
    await RuntimeMaintenance.release(lease)
  })
}, 15_000)

test("deallocation refuses a canonical live mount whose Environment index is missing", async () => {
  await fixture(async (input) => {
    const original = await WorkspaceMounts.attach(input)
    const environment = await Environment.get(input.environmentID, input.scopeID)
    await Storage.remove(["workspace_environment", input.environmentID, input.workspaceID])
    await expect(Environment.deallocate(environment.id, { scopeID: input.scopeID })).rejects.toThrow("coverage")
    expect(await Environment.get(environment.id, input.scopeID)).toEqual(environment)
    expect((await WorkspaceCatalog.get(input.workspaceID, input.scopeID)).activeMount).toEqual(original.activeMount)
  })
}, 15_000)

test("reconciling an accepted release reserves its original native Workspace before a later hold", async () => {
  await fixture(async (input) => {
    await WorkspaceMounts.attach(input)
    const failure = new Error("Original native detach was not dispatched")
    using failed = spyOn(NativeWorkspaceFiles.prototype, "detach").mockRejectedValueOnce(failure)
    await expect(Environment.deallocate(input.environmentID, { scopeID: input.scopeID })).rejects.toBe(failure)
    failed.mockRestore()
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    const detach = NativeWorkspaceFiles.prototype.detach
    using held = spyOn(NativeWorkspaceFiles.prototype, "detach").mockImplementationOnce(async function (
      this: NativeWorkspaceFiles,
      reference,
    ) {
      entered.resolve()
      await finish.promise
      return detach.call(this, reference)
    })
    const reconciling = Environment.reconcile(input.environmentID, input.scopeID)
    void reconciling.catch(() => {})
    await Promise.race([
      entered.promise,
      reconciling.then(() => {
        throw new Error("Reconciliation escaped its barrier")
      }),
    ])
    try {
      await expect(coordinatorClaim(input.directory)).rejects.toBeInstanceOf(WorkspaceAccess.BusyError)
      const lease = await begin()
      finish.resolve()
      expect((await reconciling).state).toBe("idle")
      await RuntimeMaintenance.freeze(lease, await RuntimeMaintenance.drain(lease))
      await RuntimeMaintenance.release(lease)
    } finally {
      finish.resolve()
      await reconciling
    }
  })
}, 15_000)

test("an Environment release reservation refuses a newly attached disjoint Workspace", async () => {
  await using second = await tmpdir()
  await fixture(async (input) => {
    await WorkspaceMounts.attach(input)
    const other = await WorkspaceBinding.register(input.scopeID, second.path)
    const provider = EnvironmentProviders.get("native")
    const reserve = provider.withDeallocation!
    const entered = Promise.withResolvers<void>()
    const finish = Promise.withResolvers<void>()
    using held = spyOn(provider, "withDeallocation").mockImplementation((info, release) =>
      reserve(info, async () => {
        entered.resolve()
        await finish.promise
        return release()
      }),
    )
    const releasing = Environment.deallocate(input.environmentID, { scopeID: input.scopeID })
    void releasing.catch(() => {})
    await Promise.race([
      entered.promise,
      releasing.then(() => {
        throw new Error("Release escaped its barrier")
      }),
    ])
    try {
      await expect(
        WorkspaceMounts.attach({ ...input, workspaceID: other.id, directory: second.path }),
      ).rejects.toBeInstanceOf(Environment.Busy)
      expect((await WorkspaceCatalog.get(other.id, input.scopeID)).activeMount).toBeUndefined()
    } finally {
      finish.resolve()
      await releasing
    }
  })
}, 15_000)

test("release recovery accepts only the original acknowledged native detach after a lost response", async () => {
  await fixture(async (input) => {
    await WorkspaceMounts.attach(input)
    const detach = NativeWorkspaceFiles.prototype.detach
    const lost = new Error("The original native detach acknowledgement was lost")
    using fault = spyOn(NativeWorkspaceFiles.prototype, "detach").mockImplementationOnce(async function (
      this: NativeWorkspaceFiles,
      reference,
    ) {
      await detach.call(this, reference)
      throw lost
    })
    await expect(Environment.deallocate(input.environmentID, { scopeID: input.scopeID })).rejects.toBe(lost)
    fault.mockRestore()
    const before = await Environment.get(input.environmentID, input.scopeID)
    expect(before.state).toBe("releasing")
    expect((await WorkspaceCatalog.get(input.workspaceID, input.scopeID)).activeMount).toBeDefined()
    const after = await Environment.reconcile(input.environmentID, input.scopeID)
    expect(after.state).toBe("idle")
    expect(after.generation).toBe(before.generation)
    expect((await WorkspaceCatalog.get(input.workspaceID, input.scopeID)).activeMount).toBeUndefined()
  })
}, 15_000)
