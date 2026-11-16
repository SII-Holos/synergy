import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { WorkspaceContent, WorkspaceBlobs, type BlobStore } from "../../src/workspace/content"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { WorkspaceOperations } from "../../src/workspace/operations"
import { WorkspaceTree } from "../../src/workspace/tree"
import { WorkspacePortableTree as Portable } from "../../src/workspace/portable-tree"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import type { StoreTransaction, TransactionOptions } from "../../src/storage/transactional-store"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

test("dormant mutation snapshots the operation selection before its receipt lookup", async () => {
  const store: BlobStore = {
    put: (hash, bytes) => Storage.writeBinary(["operation-selection", hash], bytes),
    get: (hash) => Storage.readBinary(["operation-selection", hash]),
  }
  await using runtime = await testRuntime({ register: () => WorkspaceBlobs.register("operation-selection", store) })
  await runtime.run(async () => {
    const original = await WorkspaceCatalog.create({
      scopeID: "scope",
      backend: { provider: "objects", spec: { blobStore: "operation-selection" } },
    })
    const other = await WorkspaceCatalog.create({
      scopeID: "scope",
      backend: { provider: "objects", spec: { blobStore: "operation-selection" } },
    })
    const input = {
      id: "original-mutation",
      scopeID: original.scopeID,
      workspaceID: original.id,
      change: { kind: "mkdir" as const, path: "original" },
    }
    const mutation = WorkspaceOperations.mutate(input)
    input.id = "changed-mutation"
    input.workspaceID = other.id
    input.change.path = "changed"
    await mutation
    expect((await WorkspaceCatalog.get(other.id, other.scopeID)).content).toEqual(other.content)
    const latest = await WorkspaceCatalog.get(original.id, original.scopeID)
    expect(await WorkspaceContent.withTree(latest, store, (tree) => tree.get("original"))).toMatchObject({
      kind: "directory",
    })
    expect((await WorkspaceOperations.get("original-mutation", original.scopeID)).workspaceID).toBe(original.id)
    let open = true
    let written = false
    const reason = new Error("Original import source ended before the business transaction committed")
    const owner = Storage.current()
    const transaction = owner.store.transaction.bind(owner.store)
    const receipt = StoragePath.workspaceOperation(original.scopeID, "restricted-mutation")
    using fault = spyOn(owner.store, "transaction").mockImplementation(
      async <T>(body: (tx: StoreTransaction) => Promise<T>, options?: TransactionOptions) =>
        transaction(async (tx) => {
          const write = tx.write.bind(tx)
          let publishing = false
          tx.write = async (...args) => {
            await write(...args)
            if (JSON.stringify(args[0]) === JSON.stringify(receipt)) publishing = true
          }
          try {
            const result = await body(tx)
            if (publishing) {
              written = true
              open = false
            }
            return result
          } finally {
            tx.write = write
          }
        }, options),
    )
    await expect(
      WorkspaceOperations.mutate({
        id: "restricted-mutation",
        scopeID: original.scopeID,
        workspaceID: original.id,
        change: { kind: "mkdir", path: "restricted" },
        assertCurrent() {
          if (!open) throw reason
        },
      }),
    ).rejects.toBe(reason)
    expect(written).toBe(true)
    expect((await WorkspaceCatalog.get(original.id, original.scopeID)).content).toEqual(latest.content)
    expect(await Storage.readMany([StoragePath.workspaceOperation(original.scopeID, "restricted-mutation")])).toEqual([
      undefined,
    ])
  })
})

test("the canonical writer relinks a legacy saved tree into a paged head without reading existing bodies", async () => {
  const bytes = new Uint8Array([3, 1, 4])
  const hash = WorkspaceTree.hash(bytes)
  const store: BlobStore = {
    put: (hash, data) => Storage.writeBinary(["legacy-producer", hash], data),
    get(hash) {
      if (hash === WorkspaceTree.hash(bytes)) throw new Error("Legacy body was fetched during mutation")
      return Storage.readBinary(["legacy-producer", hash])
    },
  }
  await using runtime = await testRuntime({ register: () => WorkspaceBlobs.register("legacy-producer", store) })
  await runtime.run(async () => {
    await store.put(hash, bytes)
    const legacy = WorkspaceTree.encode({
      version: 1,
      entries: [
        { kind: "file", path: "old", mode: 0o640, size: bytes.length, hash, chunks: [{ hash, size: bytes.length }] },
      ],
    })
    const manifest = WorkspaceTree.hash(legacy)
    await store.put(manifest, legacy)
    let info = await WorkspaceCatalog.create({
      scopeID: "legacy-scope",
      backend: { provider: "objects", spec: { blobStore: "legacy-producer" } },
    })
    info = await WorkspaceCatalog.publishContent(info, manifest)
    const updated = await WorkspaceContent.write(
      { scopeID: info.scopeID, workspaceID: info.id },
      { path: "new", data: new Uint8Array([2]), expectedVersion: null },
    )
    expect(Portable.Root.safeParse(await WorkspaceContent.storedRoot(updated, store)).success).toBe(true)
    await WorkspaceContent.withTree(updated, store, async (tree) => {
      expect(await tree.get("old")).toEqual({ kind: "file", path: "old", mode: 0o640, size: bytes.length, hash })
      for await (const entry of tree.references({ prefix: "old" }))
        expect(await Array.fromAsync(entry.chunks)).toEqual([{ hash, bytes: bytes.length }])
    })
  })
})

test("paged writes and every dormant mutation relink untouched chunks without reading their bodies", async () => {
  await using temporary = await tmpdir()
  const objects = path.join(temporary.path, "objects")
  await fs.mkdir(objects)
  const bodies = new Set<string>()
  let forbidBodies = false
  const store: BlobStore = {
    async put(hash, bytes) {
      await Bun.write(path.join(objects, hash), bytes)
    },
    get(hash) {
      if (forbidBodies && bodies.has(hash)) throw new Error("Untouched body was fetched")
      return Bun.file(path.join(objects, hash)).bytes()
    },
  }
  await using runtime = await testRuntime({ register: () => WorkspaceBlobs.register("producer-fixture", store) })
  await runtime.run(async () => {
    const root: Portable.Root = {
      version: 1,
      mode: 0o750,
      tree: await Stream.write({
        store,
        owners: { "workspace-files": 1 },
        entries: (async function* (): AsyncGenerator<Stream.Input> {
          yield {
            id: "source",
            kind: "record",
            metadata: { version: 1, kind: "directory", mode: 0o750 },
            content: (async function* () {})(),
          }
          for (let index = 0; index < 513; index++) {
            const bytes = new TextEncoder().encode(`untouched-${index}`)
            bodies.add(WorkspaceTree.hash(bytes))
            yield {
              id: `source/file-${String(index).padStart(4, "0")}`,
              kind: "file",
              metadata: { version: 1, kind: "file", mode: 0o640 },
              content: (async function* () {
                yield bytes
              })(),
            }
          }
          yield {
            id: "source/link",
            kind: "record",
            metadata: { version: 1, kind: "symlink", mode: 0o777, target: "file-0000" },
            content: (async function* () {})(),
          }
          yield {
            id: "source/escape",
            kind: "record",
            metadata: { version: 1, kind: "symlink", mode: 0o777, target: "../source/file-0000" },
            content: (async function* () {})(),
          }
        })(),
      }),
    }
    expect(root.tree.pages).toBeGreaterThan(1)
    const bytes = new TextEncoder().encode(JSON.stringify(root))
    const manifest = WorkspaceTree.hash(bytes)
    await store.put(manifest, bytes)
    const incoming: Portable.Root = {
      version: 1,
      mode: 0o755,
      tree: await Stream.write({
        store,
        owners: { "workspace-files": 1 },
        entries: (async function* (): AsyncGenerator<Stream.Input> {
          yield {
            id: "entry",
            kind: "record",
            metadata: { version: 1, kind: "directory", mode: 0o755 },
            content: (async function* () {})(),
          }
          for (let index = 0; index < 257; index++) {
            const bytes = new TextEncoder().encode(`imported-${index}`)
            bodies.add(WorkspaceTree.hash(bytes))
            yield {
              id: `entry/file-${String(index).padStart(4, "0")}`,
              kind: "file",
              metadata: { version: 1, kind: "file", mode: 0o600 },
              content: (async function* () {
                yield bytes
              })(),
            }
          }
          yield {
            id: "entry/link",
            kind: "record",
            metadata: { version: 1, kind: "symlink", mode: 0o777, target: "file-0000" },
            content: (async function* () {})(),
          }
        })(),
      }),
    }
    const incomingBytes = new TextEncoder().encode(JSON.stringify(incoming))
    const incomingHash = WorkspaceTree.hash(incomingBytes)
    await store.put(incomingHash, incomingBytes)
    let info = await WorkspaceCatalog.create({
      scopeID: "scope",
      backend: { provider: "objects", spec: { blobStore: "producer-fixture" } },
    })
    info = await WorkspaceCatalog.publishContent(info, manifest)
    const selection = { scopeID: info.scopeID, workspaceID: info.id }
    const version = async (name: string) => {
      const current = await WorkspaceCatalog.get(info.id, info.scopeID)
      return WorkspaceContent.withTree(current, store, async (tree) =>
        WorkspaceTree.entryVersion((await tree.get(name))!, current.content?.revision),
      )
    }
    forbidBodies = true
    info = await WorkspaceContent.write(selection, {
      path: "new/child.txt",
      data: new Uint8Array([1, 2, 3]),
      expectedVersion: null,
    })
    expect(Portable.Root.safeParse(await WorkspaceContent.storedRoot(info, store)).success).toBe(true)
    await WorkspaceContent.mutate(selection, { kind: "mkdir", path: "destination" })
    await WorkspaceContent.mutate(selection, {
      kind: "copy",
      from: "source",
      to: "destination/copy",
      expectedVersion: await version("source"),
    })
    await WorkspaceContent.mutate(selection, {
      kind: "move",
      from: "destination/copy",
      to: "destination/moved",
      expectedVersion: await version("destination/copy"),
    })
    await WorkspaceContent.mutate(selection, {
      kind: "replace",
      path: "new/child.txt",
      data: Buffer.from("replacement").toString("base64"),
      mode: "100755",
      expectedVersion: await version("new/child.txt"),
    })
    await WorkspaceContent.mutate(selection, {
      kind: "remove",
      path: "destination/moved",
      recursive: true,
      expectedVersion: await version("destination/moved"),
    })
    await WorkspaceContent.mutate(selection, { kind: "import", to: "destination/imported", manifest: incomingHash })
    const beforeRejected = await WorkspaceCatalog.get(info.id, info.scopeID)
    await expect(
      WorkspaceContent.mutate(selection, {
        kind: "move",
        from: "source/escape",
        to: "escape",
        expectedVersion: await version("source/escape"),
      }),
    ).rejects.toThrow()
    const badImport = WorkspaceTree.encode({
      version: 1,
      entries: [
        { kind: "directory", path: "entry", mode: 0o755 },
        { kind: "symlink", path: "entry/link", mode: 0o777, target: "../entry/file" },
      ],
    })
    const badHash = WorkspaceTree.hash(badImport)
    await store.put(badHash, badImport)
    await expect(
      WorkspaceContent.mutate(selection, { kind: "import", to: "destination/rejected", manifest: badHash }),
    ).rejects.toThrow("destination")
    expect((await WorkspaceCatalog.get(info.id, info.scopeID)).content).toEqual(beforeRejected.content)
    const latest = await WorkspaceCatalog.get(info.id, info.scopeID)
    await WorkspaceContent.withTree(latest, store, async (tree) => {
      expect((await tree.resolve("source/link")).entry?.path).toBe("source/file-0000")
      expect((await tree.get("new/child.txt"))?.mode).toBe(0o755)
      expect(await tree.get("destination/moved")).toBeUndefined()
      expect((await tree.resolve("destination/imported/link")).entry?.path).toBe("destination/imported/file-0000")
      expect((await Array.fromAsync(tree.entries())).length).toBe(778)
    })
    expect(await Storage.queryKeys({ prefix: ["environment"], limit: 1 })).toEqual([])
  })
}, 20000)

test("default paged preparation snapshots its bytes and selection and guards the outer publication transaction", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let hold: string | undefined
  const store: BlobStore = {
    put: (hash, bytes) => Storage.writeBinary(["prepared-fixture", hash], bytes),
    async get(hash) {
      if (hash === hold) {
        hold = undefined
        entered.resolve()
        await release.promise
      }
      return Storage.readBinary(["prepared-fixture", hash])
    },
  }
  await using runtime = await testRuntime({ register: () => WorkspaceBlobs.register("prepared-fixture", store) })
  await runtime.run(async () => {
    const info = await WorkspaceCatalog.create({
      scopeID: "scope",
      backend: { provider: "objects", spec: { blobStore: "prepared-fixture" } },
    })
    const selection = { scopeID: info.scopeID, workspaceID: info.id, signal: undefined as AbortSignal | undefined }
    const first = await WorkspaceContent.write(selection, {
      path: "seed",
      data: new Uint8Array([1]),
      expectedVersion: null,
    })
    hold = first.content!.manifest!
    const change = { path: "original", data: Buffer.from([7]), expectedVersion: null }
    const pending = WorkspaceContent.write(selection, change)
    try {
      await entered.promise
      selection.workspaceID = "replacement"
      change.path = "replacement"
      change.data[0] = 9
      release.resolve()
      await pending
    } finally {
      release.resolve()
      await pending.catch(() => {})
    }
    selection.workspaceID = info.id
    expect(await WorkspaceContent.read(selection, "original")).toEqual(new Uint8Array([7]))
    await expect(WorkspaceContent.read(selection, "replacement")).rejects.toThrow("absent")
    const controller = new AbortController()
    selection.signal = controller.signal
    const prepared = await WorkspaceContent.prepareWrite(selection, {
      path: "cancelled",
      data: new Uint8Array([3]),
      expectedVersion: null,
    })
    selection.signal = undefined
    const before = await WorkspaceCatalog.get(info.id, info.scopeID)
    const reason = new Error("Original preparation cancelled after the actual head write")
    await expect(
      Storage.transaction(async () => {
        await prepared.publish()
        controller.abort(reason)
      }),
    ).rejects.toBe(reason)
    expect((await WorkspaceCatalog.get(info.id, info.scopeID)).content).toEqual(before.content)
    const foreign = await WorkspaceContent.prepareWrite(selection, {
      path: "foreign",
      data: new Uint8Array([4]),
      expectedVersion: null,
    })
    const handle = Storage.current()
    await Storage.provide({ ...handle, artifactDirectory: handle.artifactDirectory + "-foreign" }, async () => {
      await expect(foreign.publish()).rejects.toThrow("artifact configuration")
    })
    const options = Storage.current().store.options
    const namespace = options.namespace
    try {
      await expect(
        Storage.transaction(async () => {
          await foreign.publish()
          options.namespace = "changed-before-commit"
        }),
      ).rejects.toThrow("Store")
    } finally {
      options.namespace = namespace
    }
    expect((await WorkspaceCatalog.get(info.id, info.scopeID)).content).toEqual(before.content)
  })
}, 20000)
