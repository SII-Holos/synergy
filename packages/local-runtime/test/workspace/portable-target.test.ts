import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import type { BlobStore } from "@ericsanchezok/synergy-harness/storage/blobs"
import { registerWorkspace } from "../../src/register-workspace"
import { WorkspaceCoordinator } from "../../src/workspace/coordinator"
import { NativeWorkspacePortableTree as Tree } from "../../src/workspace/portable-tree"
import { NativeWorkspacePortableTarget as Target } from "../../src/workspace/portable-target"

test("native target preparation stays private, verifies original bytes and holds publication only in its actual callback", async () => {
  await using temporary = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(temporary.path, "claims") })
  const home = path.join(temporary.path, "home")
  const objects = new Map<string, Uint8Array>()
  const store: BlobStore = {
    async put(hash, value) {
      objects.set(hash, value.slice())
    },
    async get(hash, maximum) {
      const value = objects.get(hash)
      if (!value || value.byteLength > maximum) throw new Error("Missing bounded object")
      return value.slice()
    },
  }
  let receipt: Target.Receipt | undefined
  {
    await using runtime = await testRuntime({
      home,
      register() {
        registerWorkspace(coordinator)
      },
    })
    await runtime.run(async () => {
      const source = path.join(temporary.path, "source")
      await fs.mkdir(source)
      await Bun.write(path.join(source, "file"), "original bytes")
      const files = await Tree.capture({ root: source, directory: path.join(temporary.path, "capture"), store })
      const request = {
        handoffID: "target-private",
        scopeID: "home",
        workspaceID: "original-workspace",
        files,
        store,
        signal: new AbortController().signal,
      }
      receipt = await Target.prepare(request)
      expect(await Bun.file(path.join(receipt.directory, "file")).text()).toBe("original bytes")
      expect((await Storage.queryKeys({ prefix: ["workspace"], limit: 1 })).length).toBe(0)
      let readUnpublished = false
      const unpublished = WorkspaceCatalog.Info.parse({
        id: receipt.workspaceID,
        scopeID: receipt.scopeID,
        type: "directory",
        revision: 1,
        binding: {
          state: "bound",
          path: receipt.directory,
          hostID: receipt.hostID,
          physicalID: receipt.physicalID,
          generation: 1,
        },
        backend: { provider: "directory", spec: {} },
        metadata: {},
        sharedWritableWorkspaceIDs: [],
        lifecycle: "active",
        createdAt: 0,
        updatedAt: 0,
      })
      await expect(
        Target.withPublishedSource(unpublished, request.signal, async () => {
          readUnpublished = true
        }),
      ).rejects.toThrow("activated publication")
      expect(readUnpublished).toBe(false)
      expect(() => Target.assertPublication(receipt!)).toThrow("publication")
      const handle = Storage.current()
      await Storage.provide(
        { ...handle, artifactDirectory: path.join(temporary.path, "foreign-artifacts") },
        async () => {
          await expect(Target.validate(receipt!, request.signal)).rejects.toThrow("original primary")
        },
      )
      await Target.withPublication([receipt], request.signal, async () => {
        expect(Target.assertPublication(receipt!)).toEqual(receipt!)
      })
      expect(() => Target.assertPublication(receipt!)).toThrow("publication")
      expect(await Target.prepare(request)).toEqual(receipt)
      await Bun.write(path.join(receipt.directory, "file"), "changed target")
      await expect(Target.withPublication([receipt!], request.signal, async () => {})).rejects.toThrow("changed")
      await Bun.write(path.join(receipt.directory, "file"), "original bytes")
      await Target.validate(receipt, request.signal)
      await expect(WorkspaceCatalog.get(receipt.workspaceID, "home")).rejects.toThrow()
    })
  }
  {
    await using runtime = await testRuntime({
      home,
      register() {
        registerWorkspace(coordinator)
      },
    })
    await runtime.run(async () => {
      await Target.validate(receipt!, new AbortController().signal)
      expect(() => Target.assertPublication(receipt!)).toThrow("publication")
    })
  }
})

test("a lost native preparation receipt rolls forward only the same intent and original verified files", async () => {
  await using temporary = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(temporary.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(coordinator)
    },
  })
  await runtime.run(async () => {
    const source = path.join(temporary.path, "source")
    await fs.mkdir(source)
    await Bun.write(path.join(source, "file"), "durable prepared bytes")
    const objects = new Map<string, Uint8Array>()
    const store: BlobStore = {
      async put(hash, value) {
        objects.set(hash, value.slice())
      },
      async get(hash, maximum) {
        const value = objects.get(hash)
        if (!value || value.byteLength > maximum) throw new Error("Missing bounded object")
        return value.slice()
      },
    }
    const files = await Tree.capture({ root: source, directory: path.join(temporary.path, "capture"), store })
    const request = {
      handoffID: "target-receipt-loss",
      scopeID: "home",
      workspaceID: "original-workspace",
      files,
      store,
      signal: new AbortController().signal,
    }
    const write = Storage.write
    let failed = false
    {
      using replaced = spyOn(Storage, "write").mockImplementation(async (key, value) => {
        if (
          !failed &&
          key[0] === "workspace_portable_native" &&
          value &&
          typeof value === "object" &&
          "phase" in value &&
          value.phase === "prepared"
        ) {
          failed = true
          throw new Error("controlled native receipt loss")
        }
        return write(key, value)
      })
      await expect(Target.prepare(request)).rejects.toThrow("receipt loss")
    }
    expect(failed).toBe(true)
    const prepared = await Target.prepare(request)
    expect(await Bun.file(path.join(prepared.directory, "file")).text()).toBe("durable prepared bytes")
    await expect(
      Target.prepare({ ...request, files: { ...files, mode: files.mode === 0o755 ? 0o700 : 0o755 } }),
    ).rejects.toThrow("immutable")
  })
})

test("native preparation retains original cancellation while its actual artifact read waits behind a checkpoint", async () => {
  await using temporary = await tmpdir()
  const coordinator = new WorkspaceCoordinator({ directory: path.join(temporary.path, "claims") })
  await using runtime = await testRuntime({
    register() {
      registerWorkspace(coordinator)
    },
  })
  await runtime.run(async () => {
    const source = path.join(temporary.path, "source")
    await fs.mkdir(source)
    await Bun.write(path.join(source, "file"), "queued original bytes")
    const reading = Promise.withResolvers<void>()
    const store: BlobStore = {
      async put(hash, bytes) {
        await Storage.writeBinary(["native-target-fixture", hash], bytes)
      },
      async get(hash, maximum) {
        reading.resolve()
        return Storage.readBinary(["native-target-fixture", hash], { maxBytes: maximum })
      },
    }
    const files = await Tree.capture({ root: source, directory: path.join(temporary.path, "capture"), store })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const held = Storage.withArtifactCheckpoint(async () => {
      entered.resolve()
      await release.promise
    })
    await entered.promise
    const original = new AbortController()
    const request = {
      handoffID: "target-cancel",
      scopeID: "home",
      workspaceID: "original-workspace",
      files,
      store,
      signal: original.signal,
    }
    let settled = false
    const preparing = Target.prepare(request).then(
      () => {
        throw new Error("Unexpected preparation success")
      },
      (error: unknown) => {
        settled = true
        return error
      },
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await reading.promise
      request.signal = new AbortController().signal
      original.abort(new Error("original preparation cancelled"))
      await Promise.race([
        preparing,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 1000)
        }),
      ])
      expect(settled).toBe(true)
      expect(String(await preparing)).toContain("cancelled")
    } finally {
      clearTimeout(timer)
      release.resolve()
      await held
      await preparing
    }
  })
})
