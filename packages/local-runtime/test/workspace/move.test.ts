import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { WorkspaceBinding, WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceContent, WorkspaceBlobs } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceMove } from "@ericsanchezok/synergy-harness/workspace/move"
import { NativeWorkspacePortableTree } from "../../src/workspace/portable-tree"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "../support/runtime"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import type { StoreTransaction, TransactionOptions } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { TransactionalStore } from "@ericsanchezok/synergy-harness/storage/transactional-store"
import { EnvironmentOrigin } from "@ericsanchezok/synergy-harness/environment/origin"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { Environment } from "@ericsanchezok/synergy-harness/environment"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { z } from "zod"
import { WorkspacePortableTree } from "@ericsanchezok/synergy-harness/workspace/portable-tree"
import { RuntimeMaintenance } from "@ericsanchezok/synergy-harness/storage/runtime-maintenance"

test("a native Workspace move captures final bytes into a reserved object subtree and never undoes published data", async () => {
  await using temporary = await tmpdir()
  const directory = path.join(temporary.path, "source")
  const objects = path.join(temporary.path, "objects")
  await fs.mkdir(directory)
  await fs.mkdir(objects)
  for (let index = 0; index < 513; index++)
    await Bun.write(path.join(directory, `file-${String(index).padStart(4, "0")}`), `before-${index}`)
  const store = {
    put: async (hash: string, bytes: Uint8Array) => {
      await Bun.write(path.join(objects, hash), bytes)
    },
    get: (hash: string) => Bun.file(path.join(objects, hash)).bytes(),
  }
  await using runtime = await testRuntime({ register: () => WorkspaceBlobs.register("move-fixture", store) })
  await runtime.run(async () => {
    const source = await WorkspaceBinding.register("home", directory)
    let target = await WorkspaceCatalog.create({
      scopeID: "home",
      backend: { provider: "objects", spec: { blobStore: "move-fixture" } },
    })
    target = await WorkspaceContent.write(
      { workspaceID: target.id, scopeID: target.scopeID },
      { path: "outside", data: Buffer.from("retained"), expectedVersion: null },
    )
    await NativeWorkspacePortableTree.capture({
      root: directory,
      directory: path.join(temporary.path, "preupload"),
      store,
    })
    await Bun.write(path.join(directory, "file-0512"), "after preupload")
    const request = {
      id: "final-native-move",
      source: { workspaceID: source.id, scopeID: source.scopeID, generation: source.binding.generation },
      target: {
        workspaceID: target.id,
        scopeID: target.scopeID,
        generation: target.binding.generation,
        path: "received",
        expectedRevision: target.revision,
      },
      mappingRevision: 1,
      acceptedDiffHash: null,
      actor: {
        kind: "local" as const,
        subjectID: "fixture",
        displayName: "Fixture",
        clientKind: "cli" as const,
        requestID: "final-native-move",
      },
    }
    const receipt = await WorkspaceMove.run(request)
    expect(receipt.source.manifest).toHaveLength(64)
    expect(await WorkspaceMove.run(request)).toEqual(receipt)
    expect(
      await WorkspaceContent.read({ workspaceID: target.id, scopeID: target.scopeID }, "received/file-0512"),
    ).toEqual(Buffer.from("after preupload"))
    expect(await WorkspaceContent.read({ workspaceID: target.id, scopeID: target.scopeID }, "outside")).toEqual(
      Buffer.from("retained"),
    )
    await expect(
      WorkspaceContent.write(
        { workspaceID: target.id, scopeID: target.scopeID },
        { path: "received/blocked", data: new Uint8Array([1]), expectedVersion: null },
      ),
    ).rejects.toThrow("reserved")
    await WorkspaceContent.write(
      { workspaceID: target.id, scopeID: target.scopeID },
      { path: "outside-new", data: new Uint8Array([2]), expectedVersion: null },
    )
    await WorkspaceMove.validate(request)
    await WorkspaceMove.release(request, "cancelled")
    expect((await WorkspaceMove.inspect(request))?.receipt).toEqual(receipt)
    expect(await Bun.file(path.join(directory, "file-0512")).text()).toBe("after preupload")
    expect(
      await WorkspaceContent.read({ workspaceID: target.id, scopeID: target.scopeID }, "received/file-0512"),
    ).toEqual(Buffer.from("after preupload"))
    await expect(WorkspaceMove.run({ ...request, mappingRevision: 2 })).rejects.toThrow("different")
  })
}, 20000)

test("cancellation at the actual native-reference commit preserves a recoverable move claim", async () => {
  await using temporary = await tmpdir()
  const directory = path.join(temporary.path, "source")
  await fs.mkdir(directory)
  await Bun.write(path.join(directory, "file"), "source")
  await using runtime = await testRuntime({
    register: () =>
      WorkspaceBlobs.register("move-cancel", {
        put: (hash, bytes) => Storage.writeBinary(["move-cancel", hash], bytes),
        get: (hash) => Storage.readBinary(["move-cancel", hash]),
      }),
  })
  await runtime.run(async () => {
    const source = await WorkspaceBinding.register("home", directory)
    const target = await WorkspaceCatalog.create({
      scopeID: "home",
      backend: { provider: "objects", spec: { blobStore: "move-cancel" } },
    })
    const request = {
      id: "cancel-native-reference",
      source: { workspaceID: source.id, scopeID: source.scopeID, generation: source.binding.generation },
      target: {
        workspaceID: target.id,
        scopeID: target.scopeID,
        generation: target.binding.generation,
        path: "received",
        expectedRevision: target.revision,
      },
      mappingRevision: 1,
      acceptedDiffHash: null,
      actor: {
        kind: "local" as const,
        subjectID: "fixture",
        displayName: "Fixture",
        clientKind: "cli" as const,
        requestID: "cancel-native-reference",
      },
    }
    const controller = new AbortController()
    const reason = new Error("Cancelled after the real native-reference write")
    const selected = Storage.current().store
    const transaction = selected.transaction.bind(selected)
    let cancelled = false
    using fault = spyOn(selected, "transaction").mockImplementation(
      async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) =>
        transaction(async (tx) => {
          const write = tx.write.bind(tx)
          let native = false
          tx.write = async (...args) => {
            await write(...args)
            if (
              args[0][0] === "workspace_move" &&
              args[1] &&
              typeof args[1] === "object" &&
              "native" in args[1] &&
              args[1].native !== undefined
            )
              native = true
          }
          try {
            const result = await body(tx)
            if (native) {
              cancelled = true
              controller.abort(reason)
            }
            return result
          } finally {
            tx.write = write
          }
        }, options),
    )
    await expect(WorkspaceMove.run(request, { signal: controller.signal })).rejects.toBe(reason)
    expect(cancelled).toBe(true)
    fault.mockRestore()
    const coordinator = new WorkspaceCoordinator({ directory: path.join(runtime.host.root, "claims") })
    expect(
      (await coordinator.inspect()).filter((claim) => claim.id.startsWith("workspace-move:") && claim.durable),
    ).toHaveLength(1)
    await WorkspaceMove.release(request, "cancelled")
    expect((await coordinator.inspect()).filter((claim) => claim.id.startsWith("workspace-move:"))).toHaveLength(0)
    expect((await WorkspaceCatalog.get(target.id, target.scopeID)).content).toEqual(target.content)
  })
})

async function fixture(maintenance = false) {
  const temporary = await tmpdir()
  const directory = path.join(temporary.path, "source")
  const objects = path.join(temporary.path, "objects")
  await fs.mkdir(directory)
  await fs.mkdir(objects)
  await Bun.write(path.join(directory, "file"), "move-body")
  let puts = 0
  const store = {
    async put(hash: string, bytes: Uint8Array) {
      if (new TextDecoder().decode(bytes) === "move-body") puts++
      await Bun.write(path.join(objects, hash), bytes)
    },
    get: (hash: string) => Bun.file(path.join(objects, hash)).bytes(),
  }
  let origin: ReturnType<typeof EnvironmentOrigin.registerHost> | undefined
  const open = () =>
    testRuntime({
      home: path.join(temporary.path, "runtime-home"),
      register() {
        WorkspaceBlobs.register("move-edge", store)
        origin = EnvironmentOrigin.registerHost("workspace-move-fixture")
        if (maintenance) RuntimeMaintenance.configure({ required: ["workspace-moves", "workspace-access"] })
      },
    })
  const runtime = await open()
  const { source, target } = await runtime.run(async () => ({
    source: await WorkspaceBinding.register("home", directory),
    target: await WorkspaceCatalog.create({
      scopeID: "home",
      backend: { provider: "objects", spec: { blobStore: "move-edge" } },
    }),
  }))
  const request = {
    id: "edge-move",
    source: { workspaceID: source.id, scopeID: source.scopeID, generation: source.binding.generation },
    target: {
      workspaceID: target.id,
      scopeID: target.scopeID,
      generation: target.binding.generation,
      path: "received",
      expectedRevision: target.revision,
    },
    mappingRevision: 1,
    acceptedDiffHash: null,
    actor: {
      kind: "local" as const,
      subjectID: "fixture",
      displayName: "Fixture",
      clientKind: "cli" as const,
      requestID: "edge-move",
    },
  }
  return {
    ...runtime,
    directory,
    store,
    source,
    target,
    request,
    puts: () => puts,
    origin: () => origin!.capture("workspace-move-fixture"),
    async reopen() {
      await runtime.close()
      return open()
    },
    coordinator: new WorkspaceCoordinator({ directory: path.join(runtime.host.root, "claims") }),
    async [Symbol.asyncDispose]() {
      await runtime.close()
      await temporary[Symbol.asyncDispose]()
    },
  }
}

test("cancellation drains an accepted native move hold before clearing its dispatch", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>()
    const acquire = WorkspaceCoordinator.prototype.acquire
    using barrier = spyOn(WorkspaceCoordinator.prototype, "acquire").mockImplementation(async function (
      this: WorkspaceCoordinator,
      input,
    ) {
      if (input.id.startsWith("workspace-move:") && input.roots?.includes(f.directory)) {
        entered.resolve()
        await resume.promise
      }
      return acquire.call(this, input)
    })
    const moving = WorkspaceMove.run(f.request)
    void moving.catch(() => {})
    await entered.promise
    expect((await WorkspaceMove.inspect(f.request))?.nativeRequested).toBe(true)
    expect((await f.coordinator.inspect()).filter((claim) => claim.id.startsWith("workspace-move:"))).toHaveLength(0)
    const terminal = Promise.withResolvers<void>()
    const selected = Storage.current().store
    const transaction = selected.transaction.bind(selected)
    using decision = spyOn(selected, "transaction").mockImplementation(
      async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) => {
        let cancelled = false
        const result = await transaction(async (tx) => {
          const write = tx.write.bind(tx)
          tx.write = async (...args) => {
            await write(...args)
            const [key, value] = args
            if (
              key[0] === "workspace_move" &&
              key.at(-1) === f.request.id &&
              value &&
              typeof value === "object" &&
              "state" in value &&
              value.state === "cancelled"
            )
              cancelled = true
          }
          try {
            return await body(tx)
          } finally {
            tx.write = write
          }
        }, options)
        if (cancelled) terminal.resolve()
        return result
      },
    )
    const releasing = WorkspaceMove.release(f.request, "cancelled")
    let rescue: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([terminal.promise, releasing])
      const retained = await WorkspaceMove.inspect(f.request)
      expect(retained?.state).toBe("cancelled")
      expect(retained?.nativeRequested).toBe(true)
      rescue = setTimeout(() => resume.resolve(), 1000)
      const released = await releasing
      resume.resolve()
      await expect(moving).rejects.toThrow("no longer owns its target reservation")
      expect(released?.nativeRequested).toBe(false)
      expect((await f.coordinator.inspect()).filter((claim) => claim.id.startsWith("workspace-move:"))).toHaveLength(0)
      expect((await WorkspaceCatalog.get(f.target.id, "home")).content).toEqual(f.target.content)
      expect(await Bun.file(path.join(f.directory, "file")).text()).toBe("move-body")
    } finally {
      clearTimeout(rescue)
      resume.resolve()
      await Promise.allSettled([moving, releasing])
      for (const claim of await f.coordinator.inspect())
        if (claim.id.startsWith("workspace-move:"))
          await (await f.coordinator.recover({ id: claim.id, token: claim.token })).release()
    }
  })
})

test("a native move rejects release reentry from its own accepted source callback", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const put = f.store.put.bind(f.store)
    let reentrant: Promise<unknown> | undefined
    using callback = spyOn(f.store, "put").mockImplementation(async (hash, bytes) => {
      await put(hash, bytes)
      if (new TextDecoder().decode(bytes) !== "move-body") return
      reentrant = WorkspaceMove.release(f.request, "cancelled").then(
        () => undefined,
        (error: unknown) => error,
      )
      const expired = Promise.withResolvers<never>()
      const rescue = setTimeout(() => expired.reject(new Error("Release waited for its own native callback")), 1000)
      try {
        const error = await Promise.race([reentrant, expired.promise])
        expect(error).toBeInstanceOf(WorkspaceMove.Rejected)
        if (error instanceof WorkspaceMove.Rejected) expect(error.data.message).toContain("reenter")
      } finally {
        clearTimeout(rescue)
      }
    })
    try {
      const receipt = await WorkspaceMove.run(f.request)
      expect(receipt.target.after.revision).toBe(1)
      expect(reentrant).toBeDefined()
      await WorkspaceMove.release(f.request, "activated")
      expect((await f.coordinator.inspect()).filter((claim) => claim.id.startsWith("workspace-move:"))).toHaveLength(0)
    } finally {
      await reentrant
      await WorkspaceMove.release(f.request, "cancelled").catch(() => {})
    }
  })
})

test("move release drains accepted source I/O after the original run signal aborts", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>()
    const put = f.store.put.bind(f.store)
    using barrier = spyOn(f.store, "put").mockImplementation(async (hash, bytes) => {
      await put(hash, bytes)
      if (new TextDecoder().decode(bytes) === "move-body") {
        entered.resolve()
        await resume.promise
      }
    })
    const controller = new AbortController()
    const reason = new Error("Original move cancelled during accepted source I/O")
    const moving = WorkspaceMove.run(f.request, { signal: controller.signal })
    void moving.catch(() => {})
    await entered.promise
    const releasing = WorkspaceMove.release(f.request, "cancelled")
    try {
      controller.abort(reason)
      resume.resolve()
      await expect(moving).rejects.toBe(reason)
      const released = await releasing
      expect(released?.state).toBe("cancelled")
      expect(released?.nativeRequested).toBe(false)
      expect((await f.coordinator.inspect()).filter((claim) => claim.id.startsWith("workspace-move:"))).toHaveLength(0)
      expect((await WorkspaceCatalog.get(f.target.id, "home")).content).toEqual(f.target.content)
    } finally {
      resume.resolve()
      await Promise.allSettled([moving, releasing])
      await WorkspaceMove.release(f.request, "cancelled").catch(() => {})
    }
  })
})

test("an accepted move cannot be joined or released through another actual Store", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>()
    const put = f.store.put.bind(f.store)
    using barrier = spyOn(f.store, "put").mockImplementation(async (hash, bytes) => {
      await put(hash, bytes)
      if (new TextDecoder().decode(bytes) === "move-body") {
        entered.resolve()
        await resume.promise
      }
    })
    const moving = WorkspaceMove.run(f.request)
    void moving.catch(() => {})
    await entered.promise
    const original = Storage.current()
    const record = await Storage.read(["workspace_move", "home", f.request.id])
    const foreign = await TransactionalStore.open({
      backend: "sqlite",
      filename: path.join(f.host.root, "pending-foreign.sqlite"),
      namespace: "pending-foreign",
    })
    let rescue: ReturnType<typeof setTimeout> | undefined
    try {
      await foreign.write(["workspace", f.source.id], f.source)
      await foreign.write(["workspace", f.target.id], f.target)
      await foreign.write(["workspace_move", "home", f.request.id], record)
      rescue = setTimeout(() => resume.resolve(), 1000)
      await Storage.provide({ ...original, store: foreign }, async () => {
        await expect(WorkspaceMove.release(f.request, "cancelled")).rejects.toThrow("another Store")
        await expect(WorkspaceMove.run(f.request)).rejects.toThrow("another Store")
        expect(await Storage.read(["workspace_move", "home", f.request.id])).toEqual(record)
      })
      resume.resolve()
      expect((await moving).target.after.revision).toBe(1)
      await WorkspaceMove.release(f.request, "activated")
      expect((await f.coordinator.inspect()).filter((claim) => claim.id.startsWith("workspace-move:"))).toHaveLength(0)
    } finally {
      clearTimeout(rescue)
      resume.resolve()
      await moving.catch(() => {})
      await WorkspaceMove.release(f.request, "cancelled").catch(() => {})
      await foreign.close()
    }
  })
})

test("an unresolved actual final move commit can only be inspected and cannot recapture or publish on retry", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const controller = new AbortController()
    const reason = new Error("Original move cancelled at the real final COMMIT")
    const selected = Storage.current().store
    const transaction = selected.transaction.bind(selected)
    let observed = false
    using fault = spyOn(selected, "transaction").mockImplementation(
      async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) =>
        transaction(async (tx) => {
          const write = tx.write.bind(tx)
          let published = false
          tx.write = async (...args) => {
            await write(...args)
            if (
              args[0][0] === "workspace_move" &&
              args[1] &&
              typeof args[1] === "object" &&
              "state" in args[1] &&
              args[1].state === "published"
            )
              published = true
          }
          try {
            const result = await body(tx)
            if (published) {
              observed = true
              controller.abort(reason)
            }
            return result
          } finally {
            tx.write = write
          }
        }, options),
    )
    await expect(WorkspaceMove.run(f.request, { signal: controller.signal })).rejects.toBe(reason)
    fault.mockRestore()
    expect(observed).toBe(true)
    expect((await WorkspaceCatalog.get(f.target.id, "home")).content).toEqual(f.target.content)
    expect((await f.coordinator.inspect()).filter((claim) => claim.id.startsWith("workspace-move:"))).toHaveLength(1)
    const before = f.puts()
    await expect(WorkspaceMove.run(f.request)).rejects.toThrow("unresolved")
    expect(f.puts()).toBe(before)
    expect((await WorkspaceCatalog.get(f.target.id, "home")).content).toEqual(f.target.content)
    await WorkspaceMove.release(f.request, "cancelled")
    expect((await f.coordinator.inspect()).filter((claim) => claim.id.startsWith("workspace-move:"))).toHaveLength(0)
  })
})

test("a lost reply after the actual move COMMIT reads the original receipt without recapturing files", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const selected = Storage.current().store
    const transaction = selected.transaction.bind(selected)
    let lost = false
    using fault = spyOn(selected, "transaction").mockImplementation(
      async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) => {
        let published = false
        const result = await transaction(async (tx) => {
          const write = tx.write.bind(tx)
          tx.write = async (...args) => {
            await write(...args)
            if (
              args[0][0] === "workspace_move" &&
              args[1] &&
              typeof args[1] === "object" &&
              "state" in args[1] &&
              args[1].state === "published"
            )
              published = true
          }
          try {
            return await body(tx)
          } finally {
            tx.write = write
          }
        }, options)
        if (published && !lost) {
          lost = true
          throw new Error("Real move COMMIT reply was lost")
        }
        return result
      },
    )
    const receipt = await WorkspaceMove.run(f.request)
    expect(lost).toBe(true)
    expect(receipt.target.after.revision).toBe(1)
    expect(await WorkspaceMove.run(f.request)).toEqual(receipt)
    expect(f.puts()).toBe(1)
    expect((await f.coordinator.inspect()).filter((claim) => claim.id.startsWith("workspace-move:"))).toHaveLength(0)
    await WorkspaceMove.release(f.request, "activated")
  })
})

test("a retained move excludes overlapping ranges and lifecycle changes while outside writes retain their own CAS", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>()
    const put = f.store.put.bind(f.store)
    using fault = spyOn(f.store, "put").mockImplementation(async (hash, bytes) => {
      await put(hash, bytes)
      if (new TextDecoder().decode(bytes) === "move-body") {
        entered.resolve()
        await resume.promise
      }
    })
    const moving = WorkspaceMove.run(f.request)
    void moving.catch(() => {})
    try {
      await entered.promise
      await expect(
        WorkspaceMove.run({ ...f.request, id: "overlap", target: { ...f.request.target, path: "received/child" } }),
      ).rejects.toThrow("reserved")
      await expect(
        WorkspaceContent.write(
          { workspaceID: f.target.id, scopeID: "home" },
          { path: "received/conflict", expectedVersion: null, data: Buffer.from("blocked") },
        ),
      ).rejects.toThrow("reserved")
      await expect(WorkspaceCatalog.beginRetirement([f.target])).rejects.toThrow("reserved")
      await expect(
        WorkspaceCatalog.rebind(f.target.id, {
          scopeID: "home",
          expectedRevision: f.target.revision,
          hostID: f.source.binding.hostID,
          path: f.directory,
          physicalID: f.source.binding.physicalID,
        }),
      ).rejects.toThrow("reserved")
      await WorkspaceContent.write(
        { workspaceID: f.target.id, scopeID: "home" },
        { path: "outside", expectedVersion: null, data: Buffer.from("independent") },
      )
    } finally {
      resume.resolve()
    }
    await expect(moving).rejects.toThrow("target changed")
    expect(await WorkspaceContent.read({ workspaceID: f.target.id, scopeID: "home" }, "outside")).toEqual(
      Buffer.from("independent"),
    )
    await expect(WorkspaceContent.read({ workspaceID: f.target.id, scopeID: "home" }, "received/file")).rejects.toThrow(
      "absent",
    )
    await WorkspaceMove.release(f.request, "cancelled")
  })
})

test("maintenance admission cannot be crossed by a move waiting on its actual final source upload", async () => {
  await using f = await fixture(true)
  await f.run(async () => {
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>()
    const put = f.store.put.bind(f.store)
    using fault = spyOn(f.store, "put").mockImplementation(async (hash, bytes) => {
      await put(hash, bytes)
      if (new TextDecoder().decode(bytes) === "move-body") {
        entered.resolve()
        await resume.promise
      }
    })
    const moving = WorkspaceMove.run(f.request)
    void moving.catch(() => {})
    await entered.promise
    let lease: Awaited<ReturnType<typeof RuntimeMaintenance.begin>> | undefined
    try {
      lease = await RuntimeMaintenance.begin({
        purpose: "organization-backup",
        requestID: "move-maintenance",
        actor: {
          kind: "system",
          subjectID: "fixture",
          displayName: "Fixture",
          clientKind: "system",
          requestID: "move-maintenance",
        },
      })
      resume.resolve()
      await expect(moving).rejects.toThrow(/maintenance/i)
      expect((await WorkspaceCatalog.get(f.target.id, "home")).content).toEqual(f.target.content)
    } finally {
      resume.resolve()
      await moving.catch(() => {})
      await WorkspaceMove.release(f.request, "cancelled")
      if (lease) await RuntimeMaintenance.release(lease)
    }
  })
})

test("an actual mounted object view blocks native moves before source capture", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const environment = await Environment.bind({
      scopeID: "home",
      ownerID: "move-mount-fixture",
      provider: "native",
      spec: {},
    })
    {
      await using resources = await EnvironmentResources.resolve({
        origin: f.origin(),
        scopeID: "home",
        workspaceID: f.target.id,
        environmentID: environment.id,
        needs: { execution: "exec" },
      })
      const current = await WorkspaceCatalog.get(f.target.id, "home")
      expect(current.activeMount?.state).toBe("active")
      await expect(
        WorkspaceMove.run({ ...f.request, target: { ...f.request.target, expectedRevision: current.revision } }),
      ).rejects.toThrow("active mount")
      expect(f.puts()).toBe(0)
      expect((await f.coordinator.inspect()).filter((claim) => claim.id.startsWith("workspace-move:"))).toHaveLength(0)
    }
    await Environment.deallocate(environment.id, { scopeID: "home" })
  })
})

test("copied move receipts in another real namespace cannot recover the original native claim", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const put = f.store.put.bind(f.store)
    using fault = spyOn(f.store, "put").mockImplementation(async (hash, bytes) => {
      await put(hash, bytes)
      if (new TextDecoder().decode(bytes) === "move-body") throw new Error("Original upload reply failed")
    })
    await expect(WorkspaceMove.run(f.request)).rejects.toThrow("upload reply")
    fault.mockRestore()
    const record = await Storage.read(["workspace_move", "home", f.request.id])
    const original = Storage.current()
    const foreign = await TransactionalStore.open({
      backend: "sqlite",
      filename: path.join(f.host.root, "foreign.sqlite"),
      namespace: "foreign",
    })
    try {
      await foreign.write(["workspace", f.source.id], f.source)
      await foreign.write(["workspace", f.target.id], f.target)
      await foreign.write(["workspace_move", "home", f.request.id], record)
      await Storage.provide({ ...original, store: foreign }, () =>
        expect(WorkspaceMove.run(f.request)).rejects.toThrow("reference changed"),
      )
      expect((await f.coordinator.inspect()).filter((claim) => claim.id.startsWith("workspace-move:"))).toHaveLength(1)
    } finally {
      await foreign.close()
    }
    await WorkspaceMove.release(f.request, "cancelled")
    expect((await f.coordinator.inspect()).filter((claim) => claim.id.startsWith("workspace-move:"))).toHaveLength(0)
  })
})

test("a cold Runtime resumes the same original exclusive claim after a pre-publication upload failure", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const put = f.store.put.bind(f.store)
    using fault = spyOn(f.store, "put").mockImplementation(async (hash, bytes) => {
      await put(hash, bytes)
      if (new TextDecoder().decode(bytes) === "move-body") throw new Error("Upload failed before publication")
    })
    await expect(WorkspaceMove.run(f.request)).rejects.toThrow("Upload failed")
    expect((await f.coordinator.inspect()).filter((claim) => claim.id.startsWith("workspace-move:"))).toHaveLength(1)
  })
  await using reopened = await f.reopen()
  await reopened.run(async () => {
    const receipt = await WorkspaceMove.run(f.request)
    expect(receipt.target.after.revision).toBe(1)
    expect(await WorkspaceContent.read({ workspaceID: f.target.id, scopeID: "home" }, "received/file")).toEqual(
      Buffer.from("move-body"),
    )
    expect((await f.coordinator.inspect()).filter((claim) => claim.id.startsWith("workspace-move:"))).toHaveLength(0)
    await WorkspaceMove.release(f.request, "activated")
  })
})

test.each(["runtime", "sharing"] as const)(
  "a native move cannot silently include unsupported source ownership (%s)",
  async (kind) => {
    await using f = await fixture()
    await f.run(async () => {
      let source = f.source
      if (kind === "runtime") {
        const privateRoot = path.join(f.host.root, "data", "private-fixture")
        await fs.mkdir(privateRoot, { recursive: true })
        await Bun.write(path.join(privateRoot, "opaque"), "runtime-private-fixture")
        source = await WorkspaceBinding.register("home", privateRoot)
      } else {
        const otherRoot = path.join(path.dirname(f.directory), "other-root")
        await fs.mkdir(otherRoot)
        const other = await WorkspaceBinding.register("home", otherRoot)
        source = await WorkspaceCatalog.setSharing(source.id, {
          scopeID: "home",
          expectedRevision: source.revision,
          workspaceIDs: [other.id],
        })
      }
      const request = {
        ...f.request,
        source: { workspaceID: source.id, scopeID: source.scopeID, generation: source.binding.generation },
      }
      await expect(WorkspaceMove.run(request)).rejects.toThrow(
        kind === "runtime" ? "Runtime data" : "additional writable",
      )
      expect((await WorkspaceCatalog.get(f.target.id, "home")).content).toEqual(f.target.content)
      await WorkspaceMove.release(request, "cancelled")
    })
  },
)

test("exclusive recovery cannot lend an original native claim to a replacement directory", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const put = f.store.put.bind(f.store)
    using fault = spyOn(f.store, "put").mockImplementation(async (hash, bytes) => {
      await put(hash, bytes)
      if (new TextDecoder().decode(bytes) === "move-body") throw new Error("Source upload failed")
    })
    await expect(WorkspaceMove.run(f.request)).rejects.toThrow("upload failed")
    fault.mockRestore()
    const record = z
      .object({ native: z.object({ claim: z.object({ id: z.string(), token: z.string() }) }) })
      .parse(await Storage.read(["workspace_move", "home", f.request.id]))
    await fs.rename(f.directory, f.directory + "-original")
    await fs.mkdir(f.directory)
    await Bun.write(path.join(f.directory, "file"), "move-body")
    await expect(WorkspaceAccess.recoverExclusive(record.native.claim)).rejects.toThrow("identity changed")
    await WorkspaceMove.release(f.request, "cancelled")
    expect((await f.coordinator.inspect()).filter((claim) => claim.id.startsWith("workspace-move:"))).toHaveLength(0)
    expect(await Bun.file(path.join(f.directory + "-original", "file")).text()).toBe("move-body")
  })
})

test("existing object destinations and unimplemented difference adoption cannot be presented as a completed copy", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const target = await WorkspaceContent.write(
      { workspaceID: f.target.id, scopeID: "home" },
      { path: "received/existing", data: Buffer.from("keep target"), expectedVersion: null },
    )
    const request = { ...f.request, target: { ...f.request.target, expectedRevision: target.revision } }
    expect(() => WorkspaceMove.Request.parse({ ...request, acceptedDiffHash: "a".repeat(64) })).toThrow()
    await expect(WorkspaceMove.run(request)).rejects.toThrow("changed")
    expect((await WorkspaceMove.inspect(request))?.receipt).toBeUndefined()
    expect((await WorkspaceCatalog.get(target.id, "home")).content).toEqual(target.content)
    expect(await WorkspaceContent.read({ workspaceID: target.id, scopeID: "home" }, "received/existing")).toEqual(
      Buffer.from("keep target"),
    )
    await WorkspaceMove.release(request, "cancelled")
  })
})

test("a final move borrows the actual retained source capture claim without replacing its owner", async () => {
  await using f = await fixture()
  await f.run(async () => {
    const original = await WorkspaceAccess.hostClaim({
      id: "original-source-capture",
      kind: "exclusive",
      roots: [f.directory],
      durable: true,
      timeoutMs: 1000,
    })
    try {
      const receipt = await WorkspaceAccess.withExclusiveClaim(original, () => WorkspaceMove.run(f.request))
      expect(receipt.source.workspaceID).toBe(f.source.id)
      expect(await original.isReleased!()).toBe(false)
      expect((await f.coordinator.inspect()).filter((claim) => claim.id.startsWith("workspace-move:"))).toHaveLength(0)
      await WorkspaceMove.release(f.request, "activated")
    } finally {
      await WorkspaceMove.release(f.request, "cancelled").catch(() => {})
      await original.release()
    }
  })
})

test("a linked Git source survives a real object move and native materialization after both source directories disappear", async () => {
  await using f = await fixture()
  const git = async (cwd: string, args: string[]) => {
    const child = Bun.spawn(["git", "-c", "core.fsmonitor=false", ...args], {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(f.host.home, "empty-global"),
        GIT_CONFIG_COUNT: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, text, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code) throw new Error(`Fixture Git ${args[0]} failed: ${error}`)
    return text
  }
  await f.run(async () => {
    await git(f.directory, ["init", "--template="])
    await git(f.directory, ["config", "user.name", "Move fixture"])
    await git(f.directory, ["config", "user.email", "move@example.invalid"])
    await Bun.write(path.join(f.directory, ".gitignore"), ".ignored\n")
    await git(f.directory, ["add", "."])
    await git(f.directory, ["commit", "--no-gpg-sign", "-m", "Fixture base"])
    const linked = f.directory + "-linked"
    await git(f.directory, ["worktree", "add", "-b", "moving", linked])
    await Bun.write(path.join(linked, "file"), "staged\n")
    await git(linked, ["add", "file"])
    await Bun.write(path.join(linked, "file"), "unstaged\n")
    await Bun.write(path.join(linked, ".ignored"), "ignored bytes")
    const expected = {
      head: await git(linked, ["rev-parse", "HEAD"]),
      status: await git(linked, ["status", "--porcelain=v1", "-z"]),
    }
    const source = await WorkspaceBinding.register("home", linked)
    const request = {
      ...f.request,
      source: { workspaceID: source.id, scopeID: source.scopeID, generation: source.binding.generation },
    }
    await WorkspaceMove.run(request)
    await fs.rm(f.directory, { recursive: true })
    await fs.rm(linked, { recursive: true })
    const target = await WorkspaceCatalog.get(f.target.id, "home")
    const root = WorkspacePortableTree.Root.parse(await WorkspaceContent.storedRoot(target, f.store))
    const restored = path.join(path.dirname(f.directory), "restored")
    await NativeWorkspacePortableTree.materialize({
      root: restored,
      captured: root,
      directory: path.join(path.dirname(f.directory), "materialize"),
      store: f.store,
    })
    expect((await fs.stat(path.join(restored, "received", ".git"))).isDirectory()).toBe(true)
    expect(await git(path.join(restored, "received"), ["rev-parse", "HEAD"])).toBe(expected.head)
    expect(await git(path.join(restored, "received"), ["status", "--porcelain=v1", "-z"])).toBe(expected.status)
    expect(await Bun.file(path.join(restored, "received", ".ignored")).text()).toBe("ignored bytes")
    await WorkspaceMove.validate(request)
    await WorkspaceMove.release(request, "activated")
  })
}, 20000)
