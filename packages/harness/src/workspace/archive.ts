import { createHash } from "node:crypto"
import { z } from "zod"
import { WorkspaceCatalog } from "./catalog"
import { WorkspaceBlobs, WorkspaceContent, type BlobStore } from "./content"
import { WorkspaceTree } from "./tree"
import { Storage } from "../storage/storage"
import { RuntimeContext } from "../lifecycle/context"
import fs from "node:fs/promises"
import path from "node:path"
import { Database } from "bun:sqlite"
import { WorkspacePortableTree as Portable } from "./portable-tree"
import { initializeSqliteEngine } from "../storage/sqlite-engine"
import { SessionTransferStream as Stream } from "../session/transfer-stream"

export namespace WorkspaceArchive {
  export class Invalid extends Error {}
  const Header = z.object({ kind: z.literal("manifest"), version: z.literal(1), tree: WorkspaceTree.Manifest }).strict()
  const PagedHeader = z.strictObject({ kind: z.literal("manifest"), version: z.literal(2), tree: Portable.Root })
  const Chunk = z
    .object({
      kind: z.literal("chunk"),
      hash: WorkspaceTree.Hash,
      data: z
        .string()
        .max(Math.ceil(WorkspaceTree.chunkBytes / 3) * 4)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    })
    .strict()
  const End = z.object({ kind: z.literal("end"), manifest: WorkspaceTree.Hash }).strict()
  function verified(hash: string, bytes: Uint8Array, maximum: number) {
    try {
      return WorkspaceTree.verify(hash, bytes, maximum)
    } catch {
      throw new Invalid("Workspace archive object integrity check failed")
    }
  }
  type Saved = { info: WorkspaceCatalog.Info; store: BlobStore; tree: WorkspaceContent.StoredTree }
  const snapshots = new WeakMap<Saved, () => void>()
  function owner(signal?: AbortSignal) {
    const runtime = RuntimeContext.current()
    const primary = runtime.storage
    const { store, artifactDirectory, artifactObjects } = Storage.current()
    const namespace = JSON.stringify(store.options)
    const objects = artifactObjects && {
      blobs: artifactObjects.blobs,
      writerID: artifactObjects.writerID,
      now: artifactObjects.now,
    }
    return () => {
      signal?.throwIfAborted()
      const current = Storage.current()
      if (
        RuntimeContext.current() !== runtime ||
        runtime.storage !== primary ||
        current.store !== store ||
        JSON.stringify(store.options) !== namespace ||
        current.artifactDirectory !== artifactDirectory ||
        current.artifactObjects !== artifactObjects ||
        artifactObjects?.blobs !== objects?.blobs ||
        artifactObjects?.writerID !== objects?.writerID ||
        artifactObjects?.now !== objects?.now
      )
        throw new Invalid("Workspace archive belongs to another Runtime or storage configuration")
    }
  }

  export async function saved(input: {
    workspaceID: string
    scopeID: string
    expectedRevision: number
  }): Promise<Saved> {
    input = { ...input }
    const assert = owner()
    const { info, store } = await WorkspaceContent.resolve(input, true)
    assert()
    if (info.revision !== input.expectedRevision)
      throw new WorkspaceCatalog.BindingChanged({
        workspaceID: info.id,
        message: "Workspace changed before saved-version export",
      })
    const get = store.get.bind(store)
    const selected: BlobStore = {
      put: store.put.bind(store),
      async get(hash, maximum) {
        assert()
        const bytes = await get(hash, maximum)
        assert()
        return bytes
      },
    }
    Object.freeze(selected)
    const tree = await WorkspaceContent.storedRoot(info, selected)
    assert()
    const value = Object.freeze({ info, store: selected, tree })
    snapshots.set(value, assert)
    return value
  }

  function chunks(tree: WorkspaceTree.Manifest) {
    const result = new Map<string, number>()
    for (const entry of tree.entries)
      if (entry.kind === "file")
        for (const chunk of entry.chunks) {
          if (result.has(chunk.hash) && result.get(chunk.hash) !== chunk.size)
            throw new Invalid("Archive chunk size conflict")
          result.set(chunk.hash, chunk.size)
        }
    return result
  }

  async function verifyFiles(tree: WorkspaceTree.Manifest, store: BlobStore, signal?: AbortSignal) {
    for (const entry of tree.entries)
      if (entry.kind === "file") {
        const digest = createHash("sha256")
        for (const chunk of entry.chunks) {
          signal?.throwIfAborted()
          const data = await store.get(chunk.hash, chunk.size)
          signal?.throwIfAborted()
          const bytes = verified(chunk.hash, data, chunk.size)
          if (bytes.length !== chunk.size) throw new Invalid("Archive chunk size mismatch")
          digest.update(bytes)
        }
        if (digest.digest("hex") !== entry.hash) throw new Invalid("Archive file integrity check failed")
      }
  }

  export async function* records(snapshot: Saved, signal?: AbortSignal): AsyncGenerator<unknown> {
    const assert = snapshots.get(snapshot)
    if (!assert) throw new Invalid("Workspace archive requires its original saved selection")
    assert()
    signal?.throwIfAborted()
    if (!("entries" in snapshot.tree)) {
      const tree = snapshot.tree
      const directory = path.join(RuntimeContext.current().host.root, "cache", "workspace-archives")
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      assert()
      await using reader = await Portable.open({ root: tree, store: snapshot.store, directory, signal })
      yield { kind: "manifest", version: 2, tree }
      for await (const object of reader.objects()) {
        assert()
        const data = await snapshot.store.get(object.hash, object.bytes)
        assert()
        signal?.throwIfAborted()
        const bytes = verified(object.hash, data, object.bytes)
        if (bytes.byteLength !== object.bytes) throw new Invalid("Archive object size mismatch")
        yield { kind: "chunk", hash: object.hash, data: Buffer.from(bytes).toString("base64") }
      }
      for await (const entry of reader.entries()) {
        assert()
        if (entry.kind === "file") for await (const _ of reader.read(entry.path)) assert()
      }
      assert()
      signal?.throwIfAborted()
      yield { kind: "end", manifest: WorkspaceTree.hash(new TextEncoder().encode(JSON.stringify(tree))) }
      return
    }
    yield { kind: "manifest", version: 1, tree: snapshot.tree }
    for (const [hash, size] of chunks(snapshot.tree)) {
      signal?.throwIfAborted()
      const data = await snapshot.store.get(hash, size)
      assert()
      signal?.throwIfAborted()
      const bytes = verified(hash, data, size)
      if (bytes.length !== size) throw new Invalid("Archive chunk size mismatch")
      yield { kind: "chunk", hash, data: Buffer.from(bytes).toString("base64") }
    }
    await verifyFiles(snapshot.tree, snapshot.store, signal)
    assert()
    signal?.throwIfAborted()
    yield { kind: "end", manifest: WorkspaceTree.hash(WorkspaceTree.encode(snapshot.tree)) }
  }

  export function stream(snapshot: Saved, signal?: AbortSignal) {
    const iterator = records(snapshot, signal)
    const runtime = RuntimeContext.current()
    return new ReadableStream<Uint8Array>({
      pull: runtime.bind(async (controller) => {
        try {
          const next = await iterator.next()
          if (next.done) controller.close()
          else controller.enqueue(new TextEncoder().encode(JSON.stringify(next.value) + "\n"))
        } catch (error) {
          controller.error(error)
        }
      }),
      cancel: runtime.bind(async () => {
        await iterator.return(undefined)
      }),
    })
  }

  export async function* parse(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
    const reader = stream.getReader()
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let pending = ""
    const limit = WorkspaceTree.manifestBytes + 1024
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        pending += decoder.decode(next.value, { stream: true })
        while (true) {
          const newline = pending.indexOf("\n")
          if (newline === -1) break
          if (newline > limit) throw new Invalid("Archive record exceeds its size limit")
          const line = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          try {
            yield JSON.parse(line)
          } catch {
            throw new Invalid("Workspace archive contains invalid JSON")
          }
        }
        if (pending.length > limit) throw new Invalid("Archive record exceeds its size limit")
      }
      pending += decoder.decode()
      if (pending.length) throw new Invalid("Workspace archive is truncated")
    } finally {
      await reader.cancel()
      reader.releaseLock()
    }
  }

  export async function restore(
    input: { scopeID: string; backend: WorkspaceCatalog.Info["backend"]; metadata?: Record<string, unknown> },
    source: AsyncIterable<unknown>,
    signal?: AbortSignal,
  ) {
    input = structuredClone(input)
    const assert = owner(signal)
    assert()
    if (input.backend?.provider !== "objects") throw new Invalid("Archive restore requires object storage")
    const spec = WorkspaceContent.Spec.parse(input.backend.spec)
    const provider = WorkspaceBlobs.get(spec.blobStore, spec.settings)
    const get = provider.get.bind(provider)
    const put = provider.put.bind(provider)
    const store: BlobStore = {
      async get(hash, maximum) {
        assert()
        const bytes = await get(hash, maximum)
        assert()
        return bytes
      },
      async put(hash, bytes) {
        assert()
        await put(hash, bytes)
        assert()
      },
    }
    let tree: WorkspaceTree.Manifest | undefined
    let remaining = new Map<string, number>()
    let finished = false
    let manifest: string | undefined
    const iterator = source[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      assert()
      if (first.done) throw new Invalid("Workspace archive is incomplete")
      const paged = PagedHeader.safeParse(first.value)
      if (paged.success) return await restorePaged(input, store, paged.data.tree, iterator, signal)
      async function* legacy() {
        yield first.value
        for (;;) {
          const next = await iterator.next()
          if (next.done) return
          yield next.value
        }
      }
      for await (const value of legacy()) {
        signal?.throwIfAborted()
        if (finished) throw new Invalid("Workspace archive has trailing records")
        if (!tree) {
          tree = Header.parse(value).tree
          manifest = WorkspaceTree.hash(WorkspaceTree.encode(tree))
          remaining = chunks(tree)
          continue
        }
        if (End.safeParse(value).success) {
          if (remaining.size || End.parse(value).manifest !== manifest)
            throw new Invalid("Workspace archive is incomplete")
          finished = true
          continue
        }
        const chunk = Chunk.parse(value)
        const size = remaining.get(chunk.hash)
        if (size === undefined) throw new Invalid("Unexpected or duplicate archive chunk")
        const bytes = verified(chunk.hash, Buffer.from(chunk.data, "base64"), size)
        if (bytes.length !== size) throw new Invalid("Archive chunk size mismatch")
        await store.put(chunk.hash, bytes)
        remaining.delete(chunk.hash)
      }
      if (!finished || !tree || !manifest) throw new Invalid("Workspace archive is incomplete")
      await verifyFiles(tree, store, signal)
      await store.put(manifest, WorkspaceTree.encode(tree))
      signal?.throwIfAborted()
      return Storage.transaction(
        async () => {
          assert()
          const workspace = await WorkspaceCatalog.create({ ...input, backend: input.backend! })
          return WorkspaceCatalog.publishContent(workspace, manifest!)
        },
        { commitGuard: assert },
      )
    } finally {
      await iterator.return?.()
    }
  }

  async function restorePaged(
    input: { scopeID: string; backend: WorkspaceCatalog.Info["backend"]; metadata?: Record<string, unknown> },
    provider: BlobStore,
    tree: Portable.Root,
    iterator: AsyncIterator<unknown>,
    signal?: AbortSignal,
  ) {
    const assert = owner(signal)
    const get = provider.get.bind(provider)
    const put = provider.put.bind(provider)
    const parent = path.join(RuntimeContext.current().host.root, "cache", "workspace-archives")
    await fs.mkdir(parent, { recursive: true, mode: 0o700 })
    assert()
    const directory = await fs.mkdtemp(path.join(parent, "restore-"))
    initializeSqliteEngine()
    const database = new Database(path.join(directory, "objects.sqlite"))
    try {
      database.exec(
        "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE received(hash TEXT PRIMARY KEY,bytes INTEGER NOT NULL)",
      )
      const find = database.query<{ bytes: number }, [string]>("SELECT bytes FROM received WHERE hash=?")
      const add = database.query("INSERT INTO received VALUES (?,?)")
      const total = database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM received")
      const bytes = new TextEncoder().encode(JSON.stringify(tree))
      const manifest = WorkspaceTree.hash(bytes)
      let finished = false
      let receivedObjects = 0n
      let receivedBytes = 0n
      const declaredEntries = BigInt(tree.tree.entries)
      const declaredBytes = BigInt(tree.tree.bytes)
      const objectLimit = declaredEntries + 2n * declaredBytes
      const byteLimit = (declaredEntries + declaredBytes) * BigInt(Stream.pageBytes) + declaredBytes
      for (;;) {
        assert()
        const next = await iterator.next()
        assert()
        if (next.done) break
        if (finished) throw new Invalid("Workspace archive has trailing records")
        const end = End.safeParse(next.value)
        if (end.success) {
          if (end.data.manifest !== manifest) throw new Invalid("Workspace archive manifest mismatch")
          finished = true
          continue
        }
        const chunk = Chunk.parse(next.value)
        if (find.get(chunk.hash)) throw new Invalid("Unexpected or duplicate archive object")
        const data = verified(chunk.hash, Buffer.from(chunk.data, "base64"), WorkspaceTree.chunkBytes)
        receivedObjects++
        receivedBytes += BigInt(data.byteLength)
        if (receivedObjects > objectLimit || receivedBytes > byteLimit)
          throw new Invalid("Workspace archive exceeds its declared object closure")
        add.run(chunk.hash, data.byteLength)
        await put(chunk.hash, data)
        assert()
      }
      if (!finished) throw new Invalid("Workspace archive is incomplete")
      const store: BlobStore = {
        put,
        async get(hash, maximum) {
          assert()
          const received = find.get(hash)
          if (!received || received.bytes > maximum)
            throw new Invalid("Workspace archive object is missing or exceeds its frame")
          const data = await get(hash, maximum)
          assert()
          if (data.byteLength !== received.bytes) throw new Invalid("Workspace archive object changed")
          return data
        },
      }
      await using reader = await Portable.open({ root: tree, store, directory, signal })
      let objects = 0
      for await (const object of reader.objects()) {
        assert()
        if (find.get(object.hash)?.bytes !== object.bytes) throw new Invalid("Workspace archive object is incomplete")
        objects++
      }
      if (objects !== total.get()!.count) throw new Invalid("Workspace archive has unreferenced objects")
      for await (const entry of reader.entries()) {
        assert()
        if (entry.kind === "file") for await (const _ of reader.read(entry.path)) assert()
      }
      await put(manifest, bytes)
      assert()
      return Storage.transaction(
        async () => {
          assert()
          const workspace = await WorkspaceCatalog.create({ ...input, backend: input.backend! })
          return WorkspaceCatalog.publishContent(workspace, manifest)
        },
        { commitGuard: assert },
      )
    } finally {
      database.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
}
