import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { WorkspaceArchive } from "../../src/workspace/archive"
import { WorkspaceBlobs, WorkspaceContent, type BlobStore } from "../../src/workspace/content"
import { WorkspaceCatalog } from "../../src/workspace/catalog"
import { WorkspacePortableTree as Portable } from "../../src/workspace/portable-tree"
import { WorkspaceTree } from "../../src/workspace/tree"
import { SessionTransferStream as Stream } from "../../src/session/transfer-stream"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

function files(directory: string): BlobStore {
  return {
    async put(hash, bytes) {
      await Bun.write(path.join(directory, hash), bytes)
    },
    async get(hash, maximum) {
      const file = Bun.file(path.join(directory, hash))
      if (file.size > maximum) throw new Error("Archive fixture frame exceeds its limit")
      return file.bytes()
    },
  }
}

async function* values(records: readonly unknown[]) {
  yield* records
}

for (const format of ["legacy", "paged"] as const)
  test(`${format} archive export rejects a body returned after cancellation`, async () => {
    await using temporary = await tmpdir()
    const store = files(temporary.path)
    const data = new Uint8Array([27, 28, 29])
    const hash = WorkspaceTree.hash(data)
    await store.put(hash, data)
    await using runtime = await testRuntime({ register: () => WorkspaceBlobs.register("fixture", store) })
    await runtime.run(async () => {
      const tree: WorkspaceContent.StoredTree =
        format === "legacy"
          ? {
              version: 1,
              entries: [
                {
                  path: "file",
                  kind: "file",
                  mode: 0o640,
                  size: data.length,
                  hash,
                  chunks: [{ hash, size: data.length }],
                },
              ],
            }
          : {
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
      const encoded = new TextEncoder().encode(JSON.stringify(tree))
      const manifest = WorkspaceTree.hash(encoded)
      await store.put(manifest, encoded)
      const initial = await WorkspaceCatalog.create({
        scopeID: "source",
        backend: { provider: "objects", spec: { blobStore: "fixture" } },
      })
      const head = await WorkspaceCatalog.publishContent(initial, manifest)
      const began = Promise.withResolvers<void>()
      const held = Promise.withResolvers<void>()
      const get = store.get.bind(store)
      store.get = async (selected, maximum) => {
        const bytes = await get(selected, maximum)
        if (selected === hash) {
          began.resolve()
          await held.promise
        }
        return bytes
      }
      const saved = await WorkspaceArchive.saved({
        workspaceID: head.id,
        scopeID: head.scopeID,
        expectedRevision: head.revision,
      })
      const controller = new AbortController()
      const reason = new Error("saved archive cancelled during original body read")
      let lateRecords = 0
      const exporting = (async () => {
        for await (const _ of WorkspaceArchive.records(saved, controller.signal))
          if (controller.signal.aborted) lateRecords++
      })()
      await began.promise
      controller.abort(reason)
      held.resolve()
      await expect(exporting).rejects.toBe(reason)
      expect(lateRecords).toBe(0)
    })
  })

test("paged saved Workspace archives survive complete source loss and reject incomplete object closure", async () => {
  await using temporary = await tmpdir()
  const sourceDirectory = path.join(temporary.path, "source")
  const targetDirectory = path.join(temporary.path, "target")
  await fs.mkdir(sourceDirectory)
  await fs.mkdir(targetDirectory)
  const sourceStore = files(sourceDirectory)
  const targetStore = files(targetDirectory)
  await using source = await testRuntime({ register: () => WorkspaceBlobs.register("fixture", sourceStore) })
  const captured = await source.run(async () => {
    const root: Portable.Root = {
      version: 1,
      mode: 0o750,
      tree: await Stream.write({
        store: sourceStore,
        owners: { "workspace-files": 1 },
        entries: (async function* (): AsyncGenerator<Stream.Input> {
          yield {
            id: "directory",
            kind: "record",
            metadata: { version: 1, kind: "directory", mode: 0o750 },
            content: (async function* () {
              yield* []
            })(),
          }
          for (let index = 0; index < 257; index++)
            yield {
              id: `directory/file-${String(index).padStart(4, "0")}`,
              kind: "file",
              metadata: { version: 1, kind: "file", mode: 0o640 },
              content: (async function* () {
                yield new TextEncoder().encode(`payload ${index % 2}`)
              })(),
            }
          yield {
            id: "link",
            kind: "record",
            metadata: { version: 1, kind: "symlink", mode: 0o777, target: "directory/file-0256" },
            content: (async function* () {
              yield* []
            })(),
          }
        })(),
      }),
    }
    const bytes = new TextEncoder().encode(JSON.stringify(root))
    const hash = WorkspaceTree.hash(bytes)
    await sourceStore.put(hash, bytes)
    const workspace = await WorkspaceCatalog.create({
      scopeID: "source-scope",
      backend: { provider: "objects", spec: { blobStore: "fixture" } },
    })
    const head = await WorkspaceCatalog.publishContent(workspace, hash)
    const saved = await WorkspaceArchive.saved({
      workspaceID: head.id,
      scopeID: head.scopeID,
      expectedRevision: head.revision,
    })
    const records = await Array.fromAsync(WorkspaceArchive.records(saved))
    await expect(Array.fromAsync(WorkspaceArchive.records({ ...saved }))).rejects.toThrow("original saved selection")
    expect(records[0]).toEqual({ kind: "manifest", version: 2, tree: root })
    expect(JSON.stringify(records)).not.toContain(sourceDirectory)
    expect(JSON.stringify(records)).not.toContain(head.id)
    return { records, sourceID: head.id, saved }
  })
  await source.close()
  await fs.rm(sourceDirectory, { recursive: true, force: true })
  await using target = await testRuntime({ register: () => WorkspaceBlobs.register("fixture", targetStore) })
  await target.run(async () => {
    await expect(Array.fromAsync(WorkspaceArchive.records(captured.saved))).rejects.toThrow("another Runtime")
    const input = { scopeID: "target-scope", backend: { provider: "objects", spec: { blobStore: "fixture" } } }
    const restored = await WorkspaceArchive.restore(input, values(captured.records))
    expect(restored.id).not.toBe(captured.sourceID)
    expect(restored.activeMount).toBeUndefined()
    expect(restored.sharedWritableWorkspaceIDs).toEqual([])
    expect(await WorkspaceContent.read({ workspaceID: restored.id, scopeID: restored.scopeID }, "link")).toEqual(
      new TextEncoder().encode("payload 0"),
    )
    const before = await WorkspaceCatalog.list(input.scopeID)
    const body = new Uint8Array([91, 92, 93])
    const extra = { kind: "chunk", hash: WorkspaceTree.hash(body), data: Buffer.from(body).toString("base64") }
    for (const broken of [
      captured.records.slice(0, -1),
      [captured.records[0], ...captured.records.slice(2)],
      [...captured.records.slice(0, -1), captured.records[1], captured.records.at(-1)],
      [...captured.records.slice(0, -1), extra, captured.records.at(-1)],
      [...captured.records, {}],
    ]) {
      await expect(WorkspaceArchive.restore(input, values(broken))).rejects.toThrow()
      expect(await WorkspaceCatalog.list(input.scopeID)).toEqual(before)
    }
    expect(await Storage.queryKeys({ prefix: ["environment"], limit: 1 })).toEqual([])
    const put = targetStore.put.bind(targetStore)
    let replaced = 0
    try {
      const changed = (async function* () {
        targetStore.put = async (hash, bytes) => {
          replaced++
          await put(hash, bytes)
        }
        yield* captured.records
      })()
      const stable = await WorkspaceArchive.restore(input, changed)
      expect(await WorkspaceContent.read({ workspaceID: stable.id, scopeID: stable.scopeID }, "link")).toEqual(
        new TextEncoder().encode("payload 0"),
      )
      expect(replaced).toBe(0)
    } finally {
      targetStore.put = put
    }
    const configuration = Storage.current().store.options
    const namespace = configuration.namespace
    let writes = 0
    targetStore.put = async (hash, bytes) => {
      writes++
      await put(hash, bytes)
    }
    try {
      const changed = (async function* () {
        configuration.namespace = "changed-before-header"
        yield* captured.records
      })()
      await expect(WorkspaceArchive.restore(input, changed)).rejects.toThrow("storage configuration")
      expect(writes).toBe(0)
    } finally {
      configuration.namespace = namespace
      targetStore.put = put
    }
  })
}, 30000)

test("an empty paged archive rejects objects beyond its declared closure before writing them", async () => {
  await using temporary = await tmpdir()
  const store = files(temporary.path)
  const put = store.put.bind(store)
  let writes = 0
  store.put = async (hash, bytes) => {
    writes++
    await put(hash, bytes)
  }
  await using runtime = await testRuntime({ register: () => WorkspaceBlobs.register("fixture", store) })
  await runtime.run(async () => {
    const tree = Portable.Root.parse({
      version: 1,
      mode: 0o750,
      tree: {
        format: "synergy-portable-session",
        version: 2,
        complete: true,
        entries: 0,
        bytes: 0,
        pages: 0,
        head: null,
        owners: { "workspace-files": 1 },
      },
    })
    const header = { kind: "manifest", version: 2, tree }
    const end = { kind: "end", manifest: WorkspaceTree.hash(new TextEncoder().encode(JSON.stringify(tree))) }
    const data = new Uint8Array([17])
    const extra = { kind: "chunk", hash: WorkspaceTree.hash(data), data: Buffer.from(data).toString("base64") }
    const input = { scopeID: "empty", backend: { provider: "objects", spec: { blobStore: "fixture" } } }
    await expect(WorkspaceArchive.restore(input, values([header, extra, end]))).rejects.toThrow(
      "declared object closure",
    )
    expect(writes).toBe(0)
    expect(await WorkspaceCatalog.list(input.scopeID)).toEqual([])
    const restored = await WorkspaceArchive.restore(input, values([header, end]))
    expect(await WorkspaceContent.storedRoot(restored, store)).toEqual(tree)
  })
})

test("valid individual archive objects cannot hide a wrong complete-file digest", async () => {
  await using temporary = await tmpdir()
  const source = path.join(temporary.path, "source")
  const target = path.join(temporary.path, "target")
  await fs.mkdir(source)
  await fs.mkdir(target)
  const store = files(source)
  const data = new Uint8Array([21, 22, 23])
  const hash = WorkspaceTree.hash(data)
  await store.put(hash, data)
  await using runtime = await testRuntime({
    register() {
      WorkspaceBlobs.register("source", store)
      WorkspaceBlobs.register("target", files(target))
    },
  })
  await runtime.run(async () => {
    const tree: Portable.Root = {
      version: 1,
      mode: 0o750,
      tree: await Stream.link({
        store,
        owners: { "workspace-files": 1 },
        entries: (async function* () {
          yield {
            id: "file",
            kind: "file" as const,
            metadata: { version: 1, kind: "file", mode: 0o640 },
            bytes: data.length,
            hash: "0".repeat(64),
            chunks: (async function* () {
              yield { hash, bytes: data.length }
            })(),
          }
        })(),
      }),
    }
    const encoded = new TextEncoder().encode(JSON.stringify(tree))
    const manifest = WorkspaceTree.hash(encoded)
    await store.put(manifest, encoded)
    const initial = await WorkspaceCatalog.create({
      scopeID: "source",
      backend: { provider: "objects", spec: { blobStore: "source" } },
    })
    const head = await WorkspaceCatalog.publishContent(initial, manifest)
    const saved = await WorkspaceArchive.saved({
      workspaceID: head.id,
      scopeID: head.scopeID,
      expectedRevision: head.revision,
    })
    await expect(Array.fromAsync(WorkspaceArchive.records(saved))).rejects.toThrow("checksum")
    await using reader = await Portable.open({ root: tree, store, directory: temporary.path })
    const records: unknown[] = [{ kind: "manifest", version: 2, tree }]
    for await (const object of reader.objects())
      records.push({
        kind: "chunk",
        hash: object.hash,
        data: Buffer.from(await store.get(object.hash, object.bytes)).toString("base64"),
      })
    records.push({ kind: "end", manifest })
    await expect(
      WorkspaceArchive.restore(
        { scopeID: "target", backend: { provider: "objects", spec: { blobStore: "target" } } },
        values(records),
      ),
    ).rejects.toThrow("checksum")
    expect(await WorkspaceCatalog.list("target")).toEqual([])
  })
})
