import path from "node:path"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import { WorkspaceCatalog } from "./catalog"
import { WorkspaceTree } from "./tree"
import { WorkspacePortableTree as Portable } from "./portable-tree"
import { Storage } from "../storage/storage"
import { SensitivePathPolicy } from "../enforcement/sensitive-path"
import { WorkspaceErrors } from "./errors"
import { WorkspaceProtocol } from "./protocol"
import { SnapshotLink } from "../session/snapshot-link"
import { SessionTransferStream as Stream } from "../session/transfer-stream"

import type { BlobStore } from "../storage/blobs"
export type { BlobStore } from "../storage/blobs"

export namespace WorkspaceBlobs {
  type Factory = (settings: Record<string, unknown>) => BlobStore
  const stores = RuntimeContext.state(() => new Map<string, { factory: Factory; cache: Map<string, BlobStore> }>())
  export function register(id: string, store: BlobStore) {
    registerFactory(id, () => store)
  }
  export function registerFactory(id: string, factory: Factory) {
    RuntimeContext.assertCompositionOpen("Workspace blob stores")
    if (stores().has(id)) throw new Error(`Duplicate Workspace blob store: ${id}`)
    stores().set(id, { factory, cache: new Map() })
  }
  export function get(id: string, settings: Record<string, unknown> = {}) {
    const entry = stores().get(id)
    if (!entry) throw new Error(`Workspace blob store is unavailable: ${id}`)
    const key = JSON.stringify(settings)
    const cached = entry.cache.get(key)
    if (cached) return cached
    const store = entry.factory(settings)
    entry.cache.set(key, store)
    while (entry.cache.size > 32) entry.cache.delete(entry.cache.keys().next().value!)
    return store
  }
}

export namespace WorkspaceContent {
  export type StoredTree = WorkspaceTree.Manifest | Portable.Root
  const cache = RuntimeContext.state(
    () => [] as Array<{ store: BlobStore; hash: string; bytes: number; tree: StoredTree }>,
  )
  export const Spec = z
    .object({
      blobStore: z.string().min(1),
      settings: z.record(z.string(), z.unknown()).optional(),
      virtualRoot: WorkspaceTree.VirtualRoot.optional(),
    })
    .strict()
  export type Selection = { workspaceID: string; scopeID: string; generation?: number; signal?: AbortSignal }

  export function captureOwner(signal?: AbortSignal) {
    const runtime = RuntimeContext.current()
    const primary = runtime.storage
    const root = runtime.host.root
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
      if (RuntimeContext.current() !== runtime || runtime.storage !== primary || runtime.host.root !== root)
        throw new Error("Workspace owner belongs to another Runtime")
      if (
        current.store !== store ||
        JSON.stringify(store.options) !== namespace ||
        current.artifactDirectory !== artifactDirectory ||
        current.artifactObjects !== artifactObjects ||
        artifactObjects?.blobs !== objects?.blobs ||
        artifactObjects?.writerID !== objects?.writerID ||
        artifactObjects?.now !== objects?.now
      )
        throw new Error("Workspace owner belongs to another Store or artifact configuration")
    }
  }

  export async function resolve(input: Selection, mounted = false) {
    input = { ...input }
    const info = await WorkspaceCatalog.get(input.workspaceID, input.scopeID)
    if (info.binding.state !== "bound" || info.lifecycle !== "active" || info.backend?.provider !== "objects")
      throw new WorkspaceCatalog.Unavailable({
        workspaceID: info.id,
        message: "Workspace has no object storage authority",
      })
    if (input.generation !== undefined && input.generation !== info.binding.generation)
      throw new WorkspaceCatalog.BindingChanged({ workspaceID: info.id, message: "Workspace binding changed" })
    if (info.activeMount && !mounted)
      throw new WorkspaceCatalog.Unavailable({
        workspaceID: info.id,
        message: "Read and write this Workspace through its active mount",
      })
    const spec = Spec.parse(info.backend.spec)
    const store = WorkspaceBlobs.get(spec.blobStore, spec.settings)
    return { info, store }
  }

  async function stored(info: WorkspaceCatalog.Info, store: BlobStore, source = store): Promise<StoredTree> {
    const manifest = info.content?.manifest
    if (!manifest) return { version: 1, entries: [] }
    const entries = cache()
    const index = entries.findIndex((entry) => entry.store === store && entry.hash === manifest)
    if (index !== -1) {
      const cached = entries.splice(index, 1)[0]!
      entries.push(cached)
      return cached.tree
    }
    const bytes = WorkspaceTree.verify(
      manifest,
      await source.get(manifest, WorkspaceTree.manifestBytes),
      WorkspaceTree.manifestBytes,
    )
    const tree = decode(manifest, bytes)
    entries.push({ store, hash: manifest, bytes: bytes.length, tree })
    while (entries.length > 8 || entries.reduce((total, entry) => total + entry.bytes, 0) > WorkspaceTree.manifestBytes)
      entries.shift()
    return tree
  }

  export function decode(manifest: string, input: Uint8Array): StoredTree {
    const bytes = WorkspaceTree.verify(manifest, input, WorkspaceTree.manifestBytes)
    const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
    const tree: StoredTree =
      raw && typeof raw === "object" && "tree" in raw ? Portable.Root.parse(raw) : WorkspaceTree.Manifest.parse(raw)
    if ("entries" in tree) {
      tree.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      for (const entry of tree.entries) {
        if (entry.kind === "file") {
          for (const chunk of entry.chunks) Object.freeze(chunk)
          Object.freeze(entry.chunks)
        }
        Object.freeze(entry)
      }
      Object.freeze(tree.entries)
    } else {
      Object.freeze(tree.tree.owners)
      Object.freeze(tree.tree)
    }
    Object.freeze(tree)
    return tree
  }

  export async function storedRoot(info: WorkspaceCatalog.Info, store: BlobStore): Promise<StoredTree> {
    return stored(info, store)
  }

  type TreeSource = Pick<
    Awaited<ReturnType<typeof Portable.open>>,
    "get" | "resolve" | "entries" | "references" | "children" | "read"
  > & {
    readonly mode: number
  }
  export type Tree = TreeSource & { assertCurrent(): void }
  const Position = z.number().int().nonnegative().safe()
  function header(entry: WorkspaceTree.Entry): Portable.Entry {
    if (entry.kind !== "file") return { ...entry }
    const { chunks: _, ...value } = entry
    return value
  }
  function legacy(tree: WorkspaceTree.Manifest, store: BlobStore): TreeSource {
    const resolve = async (filename: string, follow = true) => {
      const resolved = WorkspaceTree.resolve(tree, filename, follow)
      return { path: resolved.path, entry: resolved.entry ? header(resolved.entry) : undefined }
    }
    return {
      mode: 0o755,
      async get(filename) {
        const entry = WorkspaceTree.get(tree, filename)
        return entry ? header(entry) : undefined
      },
      resolve,
      entries(options = {}) {
        const { prefix, after } = options
        return (async function* () {
          for (const entry of tree.entries)
            if ((prefix === undefined || entry.path.startsWith(prefix)) && (after === undefined || entry.path > after))
              yield header(entry)
        })()
      },
      references(options = {}) {
        return (async function* () {
          for (const entry of tree.entries)
            if (
              (options.prefix === undefined || entry.path.startsWith(options.prefix)) &&
              (options.after === undefined || entry.path > options.after)
            )
              yield Portable.reference(
                header(entry),
                (async function* () {
                  if (entry.kind === "file")
                    for (const chunk of entry.chunks) if (chunk.size) yield { hash: chunk.hash, bytes: chunk.size }
                })(),
              )
        })()
      },
      children(directory) {
        if (directory) WorkspaceTree.Path.parse(directory)
        return (async function* () {
          for (const entry of WorkspaceTree.children(tree, directory)) yield header(entry)
        })()
      },
      read(filename, options = {}) {
        const offset = Position.parse(options.offset ?? 0)
        const length = options.length === undefined ? undefined : Position.parse(options.length)
        return (async function* () {
          const entry = WorkspaceTree.resolve(tree, filename).entry
          if (entry?.kind !== "file") throw new Error("Workspace file is absent or is not a regular file")
          const begin = Math.min(offset, entry.size)
          const end = begin + Math.min(length ?? entry.size - begin, entry.size - begin)
          const digest = offset === 0 && end === entry.size ? createHash("sha256") : undefined
          let start = 0
          for (const chunk of entry.chunks) {
            const stop = start + chunk.size
            if (stop > offset && start < end) {
              const bytes = WorkspaceTree.verify(chunk.hash, await store.get(chunk.hash, chunk.size), chunk.size)
              if (bytes.length !== chunk.size) throw new Error("Workspace file chunk is incomplete")
              const selected = bytes.subarray(Math.max(0, offset - start), Math.min(chunk.size, end - start))
              digest?.update(selected)
              yield selected
            }
            start = stop
            if (start >= end) break
          }
          if (digest && digest.digest("hex") !== entry.hash) throw new Error("Workspace file checksum mismatch")
        })()
      },
    }
  }

  export async function withTree<T>(
    info: WorkspaceCatalog.Info,
    store: BlobStore,
    body: (tree: Tree) => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    const runtime = RuntimeContext.current()
    const signal = options.signal
    const assert = captureOwner(signal)
    const get = store.get.bind(store)
    const pending = new Set<Promise<Uint8Array>>()
    const bound: BlobStore = {
      put: store.put.bind(store),
      async get(hash, maximum) {
        current()
        const reading = get(hash, maximum)
        pending.add(reading)
        try {
          const bytes = await reading
          current()
          return bytes
        } finally {
          pending.delete(reading)
        }
      },
    }
    let open = true
    let reader: Awaited<ReturnType<typeof Portable.open>> | undefined
    function current() {
      if (!open) throw new Error("Workspace tree callback has ended")
      assert()
    }
    async function* guarded<V>(source: AsyncIterable<V>) {
      current()
      const iterator = source[Symbol.asyncIterator]()
      let complete = false
      try {
        for (;;) {
          current()
          const next = await iterator.next()
          current()
          if (next.done) {
            complete = true
            return
          }
          yield next.value
        }
      } finally {
        if (!complete) await iterator.return?.()
      }
    }
    try {
      current()
      const tree = await stored(info, store, bound)
      current()
      let source: TreeSource
      if ("entries" in tree) source = legacy(tree, bound)
      else {
        const directory = path.join(runtime.host.root, "cache", "workspace-readers")
        await fs.mkdir(directory, { recursive: true, mode: 0o700 })
        current()
        reader = await Portable.open({ root: tree, store: bound, directory, signal })
        current()
        source = { ...reader, mode: tree.mode }
      }
      const result = await body(
        Object.freeze({
          mode: source.mode,
          assertCurrent: current,
          async get(filename: string) {
            current()
            const value = await source.get(filename)
            current()
            return value
          },
          async resolve(filename: string, follow?: boolean) {
            current()
            const value = await source.resolve(filename, follow)
            current()
            return value
          },
          entries(options?: { prefix?: string; after?: string }) {
            current()
            return guarded(source.entries(options))
          },
          references(options?: { prefix?: string; after?: string }) {
            current()
            return guarded(
              (async function* () {
                for await (const entry of source.references(options)) yield { ...entry, chunks: guarded(entry.chunks) }
              })(),
            )
          },
          children(directory: string) {
            current()
            return guarded(source.children(directory))
          },
          read(filename: string, options?: { offset?: number; length?: number }) {
            current()
            return guarded(source.read(filename, options))
          },
        }),
      )
      current()
      return result
    } finally {
      open = false
      await Promise.allSettled([...pending])
      await reader?.close()
    }
  }

  export async function read(
    input: Selection,
    filename: string,
    maximumBytes = WorkspaceTree.chunkBytes,
  ): Promise<Uint8Array> {
    WorkspaceTree.Path.parse(filename)
    const { info, store } = await resolve(input)
    return withTree(info, store, async (tree) => {
      const entry = (await tree.resolve(filename)).entry
      if (entry?.kind !== "file") throw new Error("Workspace file is absent or is not a regular file")
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || entry.size > maximumBytes)
        throw new Error("Workspace file exceeds the read limit")
      const bytes = new Uint8Array(entry.size)
      let offset = 0
      for await (const chunk of tree.read(entry.path)) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }
      return WorkspaceTree.verify(entry.hash, bytes, maximumBytes)
    })
  }

  export async function readRange(input: Selection, filename: string, offset: number, length: number) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > WorkspaceTree.chunkBytes
    )
      throw new Error("Invalid Workspace read range")
    const { info, store } = await resolve(input)
    return withTree(info, store, async (tree) => {
      const entry = (await tree.resolve(filename)).entry
      if (entry?.kind !== "file") throw new Error("Workspace file is absent or is not a regular file")
      const bytes = new Uint8Array(Math.min(length, Math.max(0, entry.size - offset)))
      let written = 0
      for await (const chunk of tree.read(entry.path, { offset, length })) {
        bytes.set(chunk, written)
        written += chunk.length
      }
      if (written !== bytes.length) throw new Error("Workspace file range is incomplete")
      return { bytes, version: `sha256:${entry.hash}`, size: entry.size, mode: entry.mode }
    })
  }

  export interface Prepared {
    readonly info: WorkspaceCatalog.Info
    readonly manifest: string
    publish(): Promise<WorkspaceCatalog.Info>
  }

  function ports(store: BlobStore, assert: () => void): BlobStore {
    const put = store.put.bind(store)
    const get = store.get.bind(store)
    return {
      async put(hash, bytes) {
        assert()
        await put(hash, bytes)
        assert()
      },
      async get(hash, maximum) {
        assert()
        const bytes = await get(hash, maximum)
        assert()
        return bytes
      },
    }
  }

  async function finish(
    info: WorkspaceCatalog.Info,
    store: BlobStore,
    entries: AsyncIterable<Stream.Reference>,
    mode: number,
    assert: () => void,
    signal?: AbortSignal,
  ): Promise<Prepared> {
    const tree = Portable.Root.parse({
      version: 1,
      mode,
      tree: await Stream.link({ store, owners: { "workspace-files": 1 }, entries, signal }),
    })
    assert()
    const bytes = new TextEncoder().encode(JSON.stringify(tree))
    const manifest = WorkspaceTree.hash(bytes)
    await store.put(manifest, bytes)
    assert()
    const original = WorkspaceCatalog.Info.parse(info)
    return Object.freeze({
      info: WorkspaceCatalog.Info.parse(original),
      manifest,
      async publish() {
        assert()
        return Storage.transaction(
          async () => {
            assert()
            return WorkspaceCatalog.publishContent(original, manifest)
          },
          { commitGuard: assert },
        )
      },
    })
  }

  async function prepare(
    selection: Selection,
    body: (input: {
      info: WorkspaceCatalog.Info
      store: BlobStore
      tree: Tree
      finish(entries: AsyncIterable<Stream.Reference>): Promise<Prepared>
    }) => Promise<Prepared>,
  ) {
    const input = { ...selection }
    const assert = captureOwner(input.signal)
    assert()
    const selected = await resolve(input)
    assert()
    const store = ports(selected.store, assert)
    return withTree(
      selected.info,
      store,
      (tree) =>
        body({
          ...selected,
          store,
          tree,
          finish: (entries) => finish(selected.info, store, entries, tree.mode, assert, input.signal),
        }),
      { signal: input.signal },
    )
  }

  async function parents(tree: Tree, filename: string, create: boolean) {
    const missing: WorkspaceTree.Header[] = []
    for (let name = path.posix.dirname(filename); name !== "."; name = path.posix.dirname(name)) {
      const parent = await tree.get(name)
      if (!parent) {
        if (!create) throw new Error("Workspace parent directory is absent")
        missing.push({ kind: "directory", path: name, mode: 0o755 })
      } else if (parent.kind !== "directory" || !(parent.mode & 0o222))
        throw new WorkspaceErrors.AccessDeniedError("Workspace parent is not a writable directory")
    }
    return missing
  }

  const emptyChunks = async function* () {}
  function metadata(entry: WorkspaceTree.Header) {
    return Portable.reference(entry, emptyChunks())
  }
  function file(filename: string, data: Uint8Array, mode: number, store: BlobStore) {
    return Portable.reference(
      {
        path: filename,
        kind: "file",
        mode,
        size: data.byteLength,
        hash: WorkspaceTree.hash(data),
      },
      (async function* () {
        for (let offset = 0; offset < data.byteLength; offset += Stream.chunkBytes) {
          const bytes = data.slice(offset, offset + Stream.chunkBytes)
          const hash = WorkspaceTree.hash(bytes)
          await store.put(hash, bytes)
          yield { hash, bytes: bytes.byteLength }
        }
      })(),
    )
  }
  const member = (name: string, root: string) => name === root || name.startsWith(root + "/")

  export async function prepareWrite(
    selection: Selection,
    raw: {
      path: string
      data: Uint8Array
      expectedVersion: string | null
      expectedEntryVersion?: string | null
      mode?: number
      protectSensitive?: boolean
    },
  ) {
    const change = { ...raw, path: WorkspaceTree.Path.parse(raw.path), data: Uint8Array.from(raw.data) }
    return prepare({ ...selection }, async ({ info, store, tree, finish }) => {
      const resolved = await tree.resolve(change.path)
      const filename = WorkspaceTree.Path.parse(resolved.path)
      if (change.protectSensitive) protectedPath(filename)
      const previous = resolved.entry
      if (
        change.expectedEntryVersion !== undefined &&
        change.expectedEntryVersion !== (previous ? WorkspaceTree.entryVersion(previous, info.content?.revision) : null)
      )
        throw new WorkspaceErrors.ConflictError()
      if (previous && !(previous.mode & 0o222))
        throw new WorkspaceErrors.AccessDeniedError("Workspace file is read-only")
      if (
        (previous && previous.kind !== "file") ||
        (previous?.kind === "file" ? "sha256:" + previous.hash : null) !== change.expectedVersion
      )
        throw new WorkspaceErrors.ConflictError()
      const missing = await parents(tree, filename, true)
      return finish(
        (async function* () {
          for await (const entry of tree.references()) if (entry.id !== filename) yield entry
          for (const entry of missing) yield metadata(entry)
          yield file(filename, change.data, change.mode ?? previous?.mode ?? 0o644, store)
        })(),
      )
    })
  }

  export async function write(input: Selection, change: Parameters<typeof prepareWrite>[1]) {
    return (await prepareWrite(input, change)).publish()
  }

  export async function prepareChange(selection: Selection, raw: WorkspaceProtocol.Change, protectSensitive?: boolean) {
    const change = WorkspaceProtocol.Change.parse(raw)
    const input = { ...selection }
    return prepare(input, async ({ info, store, tree, finish }) => {
      const from = await tree.resolve(
        "path" in change ? change.path : change.kind === "import" ? change.to : change.from,
        false,
      )
      if (protectSensitive) protectedPath(from.path)
      const conflict = () => new WorkspaceErrors.ConflictError()
      if (change.kind === "replace") {
        if (
          (from.entry ? WorkspaceTree.entryVersion(from.entry, info.content?.revision) : null) !==
          change.expectedVersion
        )
          throw conflict()
        if (from.entry?.kind === "directory" || (from.entry?.kind === "file" && !(from.entry.mode & 0o222)))
          throw new WorkspaceErrors.AccessDeniedError("Workspace entry cannot be replaced")
        if (
          change.expectedContentVersion !== undefined &&
          (from.entry?.kind !== "file" || "sha256:" + from.entry.hash !== change.expectedContentVersion)
        )
          throw conflict()
        const data = Buffer.from(change.data, "base64")
        if (data.toString("base64") !== change.data || data.length > WorkspaceProtocol.writeBytes)
          throw new Error("Invalid replacement bytes")
        const missing = await parents(tree, from.path, true)
        const replacement =
          change.mode === "120000"
            ? metadata({ kind: "symlink", path: from.path, mode: 0o777, target: SnapshotLink.decode(data).target })
            : file(from.path, data, change.mode === "100755" ? 0o755 : 0o644, store)
        return finish(
          (async function* () {
            for await (const entry of tree.references()) if (entry.id !== from.path) yield entry
            for (const entry of missing) yield metadata(entry)
            yield replacement
          })(),
        )
      }
      if (change.kind === "import") {
        if (from.entry) throw conflict()
        const missing = await parents(tree, from.path, true)
        const incoming = WorkspaceCatalog.Info.parse({
          ...info,
          content: { revision: info.content?.revision ?? 0, manifest: change.manifest },
        })
        return withTree(
          incoming,
          store,
          async (source) => {
            if (!(await source.get("entry"))) throw new Error("Transfer has no root entry")
            return finish(
              (async function* () {
                yield* tree.references()
                for (const entry of missing) yield metadata(entry)
                for await (const entry of source.references()) {
                  const original = await source.get(entry.id)
                  const relocated = WorkspaceTree.importHeader(original!, from.path)
                  if (protectSensitive) protectedPath(relocated.path)
                  yield { ...entry, id: Portable.path(relocated.path, Portable.Metadata.parse(entry.metadata)) }
                }
              })(),
            )
          },
          { signal: input.signal },
        )
      }
      if (change.kind === "mkdir") {
        if (from.entry) throw conflict()
        const missing = await parents(tree, from.path, change.createParents ?? false)
        return finish(
          (async function* () {
            yield* tree.references()
            for (const entry of missing) yield metadata(entry)
            yield metadata({ kind: "directory", path: from.path, mode: change.mode ?? 0o755 })
          })(),
        )
      }
      if (!from.entry || WorkspaceTree.entryVersion(from.entry, info.content?.revision) !== change.expectedVersion)
        throw conflict()
      if (change.kind === "remove") {
        if (!change.recursive) {
          const children = tree.entries({ prefix: from.path + "/" })
          const next = await children.next()
          await children.return(undefined)
          if (!next.done) throw new Error("Directory is not empty; recursive removal is required")
        }
        await parents(tree, from.path, false)
        return finish(
          (async function* () {
            for await (const entry of tree.references()) {
              if (member(entry.id, from.path)) {
                if (protectSensitive) protectedPath(entry.id)
              } else yield entry
            }
          })(),
        )
      }
      const to = await tree.resolve(change.to, false)
      if (to.entry) throw conflict()
      if (member(from.path, to.path) || member(to.path, from.path))
        throw new Error("Source and destination must be separate filesystem entries")
      await parents(tree, to.path, false)
      if (change.kind === "move") await parents(tree, from.path, false)
      return finish(
        (async function* () {
          for await (const entry of tree.references())
            if (change.kind !== "move" || !member(entry.id, from.path)) yield entry
          for await (const entry of tree.references({ prefix: from.path })) {
            if (!member(entry.id, from.path)) continue
            const filename = to.path + entry.id.slice(from.path.length)
            if (protectSensitive) {
              protectedPath(entry.id)
              protectedPath(filename)
            }
            yield { ...entry, id: Portable.path(filename, Portable.Metadata.parse(entry.metadata)) }
          }
        })(),
      )
    })
  }

  export async function mutate(input: Selection, change: WorkspaceProtocol.Change) {
    return (await prepareChange(input, change)).publish()
  }

  function protectedPath(filename: string) {
    if (SensitivePathPolicy.classifyRelative(filename).matched)
      throw new WorkspaceErrors.AccessDeniedError("Access denied: protected filesystem entry")
  }

  export async function publish(info: WorkspaceCatalog.Info, provider: BlobStore, raw: WorkspaceTree.Manifest) {
    const input = WorkspaceCatalog.Info.parse(info)
    const tree = WorkspaceTree.Manifest.parse(raw)
    const assert = captureOwner()
    const store = ports(provider, assert)
    const prepared = await finish(input, store, legacy(tree, store).references(), 0o755, assert)
    return prepared.publish()
  }
}
