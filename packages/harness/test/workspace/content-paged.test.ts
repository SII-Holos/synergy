import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { WorkspaceContent, WorkspaceBlobs, type BlobStore } from "../../src/workspace/content"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { WorkspacePortableTree as Portable } from "../../src/workspace/portable-tree"
import { WorkspaceTree } from "../../src/workspace/tree"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

test("canonical object reads select paged Workspace content without fetching unrelated files or allocating compute", async () => {
  await using temporary = await tmpdir()
  const objects = path.join(temporary.path, "objects")
  await fs.mkdir(objects)
  const body = new TextEncoder().encode("selected paged file")
  const bodyHash = WorkspaceTree.hash(body)
  let bodyReads = 0
  const unrelated = new Set<string>()
  const reads: string[] = []
  const store: BlobStore = {
    async put(hash, bytes) {
      await Bun.write(path.join(objects, hash), bytes)
    },
    async get(hash, maximum) {
      reads.push(hash)
      if (hash === bodyHash) bodyReads++
      const file = Bun.file(path.join(objects, hash))
      if (file.size > maximum) throw new Error("Workspace fixture object exceeds its frame")
      return file.bytes()
    },
  }
  const root: Portable.Root = {
    version: 1,
    mode: 0o750,
    tree: await Stream.write({
      store,
      owners: { "workspace-files": 1 },
      entries: (async function* (): AsyncGenerator<Stream.Input> {
        for (let index = 0; index < 513; index++) {
          const bytes = index === 512 ? body : new TextEncoder().encode(`unrelated ${index}`)
          if (index !== 512) unrelated.add(WorkspaceTree.hash(bytes))
          yield {
            id: `file-${String(index).padStart(4, "0")}`,
            kind: "file",
            metadata: { version: 1, kind: "file", mode: 0o640 },
            content: (async function* () {
              yield bytes
            })(),
          }
        }
        yield {
          id: "link",
          kind: "record",
          metadata: { version: 1, kind: "symlink", mode: 0o777, target: "file-0512" },
          content: (async function* () {
            yield* []
          })(),
        }
      })(),
    }),
  }
  const bytes = new TextEncoder().encode(JSON.stringify(root))
  const manifest = WorkspaceTree.hash(bytes)
  await store.put(manifest, bytes)
  await using runtime = await testRuntime({ register: () => WorkspaceBlobs.register("paged-fixture", store) })
  await runtime.run(async () => {
    let info = await WorkspaceCatalog.create({
      scopeID: "paged-scope",
      backend: { provider: "objects", spec: { blobStore: "paged-fixture" } },
    })
    info = await WorkspaceCatalog.publishContent(info, manifest)
    const selection = { scopeID: info.scopeID, workspaceID: info.id, generation: info.binding.generation }
    expect(await WorkspaceContent.readRange(selection, "link", 9, 5)).toEqual({
      bytes: body.subarray(9, 14),
      version: `sha256:${bodyHash}`,
      size: body.byteLength,
      mode: 0o640,
    })
    expect(bodyReads).toBe(1)
    expect(await WorkspaceContent.read(selection, "file-0512")).toEqual(body)
    expect(reads.some((hash) => unrelated.has(hash))).toBe(false)
    expect((await WorkspaceContent.readRange(selection, "link", Number.MAX_SAFE_INTEGER, 4)).bytes).toHaveLength(0)
    expect(bodyReads).toBe(2)
    expect(await Storage.queryKeys({ prefix: ["environment"], limit: 1 })).toEqual([])
    await expect(WorkspaceContent.read({ ...selection, generation: 99 }, "link")).rejects.toMatchObject({
      name: "WorkspaceBindingChanged",
    })
  })
}, 20000)

async function indexedFixture(
  body: (input: { info: WorkspaceCatalog.Info; store: BlobStore; hash: string }) => Promise<void>,
) {
  await using temporary = await tmpdir()
  const data = new Uint8Array([11, 12, 13])
  const hash = WorkspaceTree.hash(data)
  const objects = path.join(temporary.path, "objects")
  await fs.mkdir(objects)
  const store: BlobStore = {
    async put(hash, bytes) {
      await Bun.write(path.join(objects, hash), bytes)
    },
    get(hash) {
      return Bun.file(path.join(objects, hash)).bytes()
    },
  }
  await using runtime = await testRuntime({ register: () => WorkspaceBlobs.register("indexed-fixture", store) })
  await runtime.run(async () => {
    const root: Portable.Root = {
      version: 1,
      mode: 0o750,
      tree: await Stream.write({
        store,
        owners: { "workspace-files": 1 },
        entries: (async function* () {
          yield {
            id: "file",
            kind: "file" as const,
            metadata: { version: 1, kind: "file", mode: 0o640 },
            content: (async function* () {
              yield data
            })(),
          }
        })(),
      }),
    }
    const bytes = new TextEncoder().encode(JSON.stringify(root))
    const manifest = WorkspaceTree.hash(bytes)
    await store.put(manifest, bytes)
    const workspace = await WorkspaceCatalog.create({
      scopeID: "indexed-scope",
      backend: { provider: "objects", spec: { blobStore: "indexed-fixture" } },
    })
    const info = await WorkspaceCatalog.publishContent(workspace, manifest)
    await body({ info, store, hash })
  })
}

test("indexed Workspace callbacks cannot escape, change Store namespaces or use a foreign Runtime", async () => {
  await using foreign = await testRuntime()
  await indexedFixture(async ({ info, store }) => {
    let retained: WorkspaceContent.Tree | undefined
    let content: AsyncIterator<Uint8Array> | undefined
    let entries: AsyncIterator<Portable.Entry> | undefined
    let children: AsyncIterator<Portable.Entry> | undefined
    let references: AsyncIterator<Stream.Reference> | undefined
    let chunks: AsyncIterator<{ hash: string; bytes: number }> | undefined
    await WorkspaceContent.withTree(info, store, async (tree) => {
      retained = tree
      tree.assertCurrent()
      content = tree.read("file")[Symbol.asyncIterator]()
      entries = tree.entries()[Symbol.asyncIterator]()
      expect((await Array.fromAsync(tree.children(""))).map((entry) => entry.path)).toEqual(["file"])
      children = tree.children("")[Symbol.asyncIterator]()
      references = tree.references()[Symbol.asyncIterator]()
      const reference = await tree.references().next()
      if (reference.done) throw new Error("Workspace file reference was not found")
      chunks = reference.value.chunks[Symbol.asyncIterator]()
      await foreign.run(() => expect(tree.get("file")).rejects.toThrow("another Runtime"))
      const foreignReference = await tree.references().next()
      if (foreignReference.done) throw new Error("Workspace file reference was not found")
      await foreign.run(() =>
        expect(foreignReference.value.chunks[Symbol.asyncIterator]().next()).rejects.toThrow("another Runtime"),
      )
      const handle = Storage.current()
      await Storage.provide({ ...handle, artifactDirectory: handle.artifactDirectory + "-foreign" }, () =>
        expect(tree.get("file")).rejects.toThrow("artifact"),
      )
      const namespace = handle.store.options.namespace
      try {
        handle.store.options.namespace = "foreign-namespace"
        expect(() => tree.assertCurrent()).toThrow("Store")
        await expect(tree.get("file")).rejects.toThrow("Store")
      } finally {
        handle.store.options.namespace = namespace
      }
    })
    if (!retained || !content || !entries || !children || !references || !chunks)
      throw new Error("Workspace reader was not opened")
    const original = retained
    await expect(original.get("file")).rejects.toThrow("ended")
    expect(() => original.assertCurrent()).toThrow("ended")
    await expect(content.next()).rejects.toThrow("ended")
    await expect(entries.next()).rejects.toThrow("ended")
    await expect(children.next()).rejects.toThrow("ended")
    await expect(references.next()).rejects.toThrow("ended")
    await expect(chunks.next()).rejects.toThrow("ended")
  })
})

test("indexed Workspace reads retain original cancellation while their real body read waits", async () => {
  await indexedFixture(async ({ info, store, hash }) => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const get = store.get.bind(store)
    store.get = async (selected, maximum) => {
      if (selected === hash) {
        entered.resolve()
        await release.promise
      }
      return get(selected, maximum)
    }
    const controller = new AbortController()
    const options: { signal?: AbortSignal } = { signal: controller.signal }
    const reason = new Error("original Workspace cancellation")
    const reading = WorkspaceContent.withTree(
      info,
      store,
      async (tree) => {
        for await (const _ of tree.read("file")) throw new Error("cancelled Workspace body escaped")
      },
      options,
    )
    try {
      await entered.promise
      options.signal = undefined
      controller.abort(reason)
      release.resolve()
      await expect(reading).rejects.toBe(reason)
    } finally {
      release.resolve()
      await reading.catch(() => {})
    }
  })
})

test("leaving a Workspace callback drains its accepted body I/O and retires its result", async () => {
  await indexedFixture(async ({ info, store, hash }) => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const returning = Promise.withResolvers<void>()
    const get = store.get.bind(store)
    store.get = async (selected, maximum) => {
      if (selected === hash) {
        entered.resolve()
        await release.promise
      }
      return get(selected, maximum)
    }
    let content: Promise<IteratorResult<Uint8Array>> | undefined
    const callback = WorkspaceContent.withTree(info, store, async (tree) => {
      content = tree.read("file")[Symbol.asyncIterator]().next()
      void content.catch(() => {})
      await entered.promise
      returning.resolve()
    })
    try {
      await returning.promise
      const early = await Promise.race([callback.then(() => true), Bun.sleep(60).then(() => false)])
      release.resolve()
      await callback
      expect(early).toBe(false)
      if (!content) throw new Error("Workspace body read was not admitted")
      await expect(content).rejects.toThrow()
    } finally {
      release.resolve()
      await callback.catch(() => {})
    }
  })
})

test("Workspace entry versions depend on canonical file metadata rather than its chunk representation", () => {
  const entry: WorkspaceTree.Entry = {
    path: "file",
    kind: "file",
    mode: 0o640,
    size: 3,
    hash: WorkspaceTree.hash(new Uint8Array([1, 2, 3])),
    chunks: [{ hash: WorkspaceTree.hash(new Uint8Array([1, 2, 3])), size: 3 }],
  }
  const { chunks: _, ...header } = entry
  expect(WorkspaceTree.entryVersion(entry, 4)).toBe(WorkspaceTree.entryVersion(header, 4))
  expect(WorkspaceTree.entryVersion(header, 4)).not.toBe(WorkspaceTree.entryVersion({ ...header, mode: 0o600 }, 4))
  expect(WorkspaceTree.entryVersion(header, 4)).not.toBe(WorkspaceTree.entryVersion(header, 5))
})

test("a completed Workspace callback rechecks its actual namespace before returning its result", async () => {
  await indexedFixture(async ({ info, store }) => {
    const options = Storage.current().store.options
    const namespace = options.namespace
    try {
      await expect(
        WorkspaceContent.withTree(info, store, async (tree) => {
          const result = await tree.get("file")
          options.namespace = "replaced-before-return"
          return result
        }),
      ).rejects.toThrow("Store")
    } finally {
      options.namespace = namespace
    }
  })
})
