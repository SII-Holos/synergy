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
  type StoredTree = WorkspaceTree.Manifest | Portable.Root
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
  export type Selection = { workspaceID: string; scopeID: string; generation?: number }

  export async function resolve(input: Selection, mounted = false) {
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
    entries.push({ store, hash: manifest, bytes: bytes.length, tree })
    while (entries.length > 8 || entries.reduce((total, entry) => total + entry.bytes, 0) > WorkspaceTree.manifestBytes)
      entries.shift()
    return tree
  }

  export async function manifest(info: WorkspaceCatalog.Info, store: BlobStore): Promise<WorkspaceTree.Manifest> {
    const tree = await stored(info, store)
    if (!("entries" in tree)) throw new Error("Paged Workspace content requires its indexed tree owner")
    return tree
  }

  export type Tree = Pick<Awaited<ReturnType<typeof Portable.open>>, "get" | "resolve" | "entries" | "read"> & {
    readonly mode: number
  }
  const Position = z.number().int().nonnegative().safe()
  function header(entry: WorkspaceTree.Entry): Portable.Entry {
    if (entry.kind !== "file") return { ...entry }
    const { chunks: _, ...value } = entry
    return value
  }
  function legacy(tree: WorkspaceTree.Manifest, store: BlobStore): Tree {
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
    const primary = runtime.storage
    const root = runtime.host.root
    const selected = Storage.current()
    const owner = { store: selected.store, artifacts: selected.artifactDirectory, objects: selected.artifactObjects }
    const namespace = JSON.stringify(owner.store.options)
    const objectConfig = owner.objects && {
      blobs: owner.objects.blobs,
      writerID: owner.objects.writerID,
      now: owner.objects.now,
    }
    const signal = options.signal
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
      signal?.throwIfAborted()
      if (RuntimeContext.current() !== runtime || runtime.storage !== primary || runtime.host.root !== root)
        throw new Error("Workspace tree belongs to another Runtime")
      const handle = Storage.current()
      if (
        handle.store !== owner.store ||
        JSON.stringify(owner.store.options) !== namespace ||
        handle.artifactDirectory !== owner.artifacts ||
        handle.artifactObjects !== owner.objects ||
        owner.objects?.blobs !== objectConfig?.blobs ||
        owner.objects?.writerID !== objectConfig?.writerID ||
        owner.objects?.now !== objectConfig?.now
      )
        throw new Error("Workspace tree belongs to another Store or artifact configuration")
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
      let source: Tree
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

  export async function prepareWrite(
    input: Selection,
    change: {
      path: string
      data: Uint8Array
      expectedVersion: string | null
      expectedEntryVersion?: string | null
      mode?: number
      protectSensitive?: boolean
    },
  ) {
    WorkspaceTree.Path.parse(change.path)
    const { info, store } = await resolve(input)
    const tree = await manifest(info, store)
    const resolved = WorkspaceTree.resolve(tree, change.path)
    change = { ...change, path: WorkspaceTree.Path.parse(resolved.path) }
    if (change.protectSensitive) protectedPath(change.path)
    const previous = resolved.entry
    if (
      change.expectedEntryVersion !== undefined &&
      change.expectedEntryVersion !== (previous ? WorkspaceTree.entryVersion(previous, info.content?.revision) : null)
    )
      throw new WorkspaceErrors.ConflictError()
    if (previous && !(previous.mode & 0o222)) throw new WorkspaceErrors.AccessDeniedError("Workspace file is read-only")
    if (
      (previous && previous.kind !== "file") ||
      (previous?.kind === "file" ? `sha256:${previous.hash}` : null) !== change.expectedVersion
    )
      throw new WorkspaceErrors.ConflictError()
    const chunks = []
    for (let offset = 0; offset < change.data.length; offset += WorkspaceTree.chunkBytes) {
      const bytes = change.data.subarray(offset, offset + WorkspaceTree.chunkBytes)
      const hash = WorkspaceTree.hash(bytes)
      await store.put(hash, bytes)
      chunks.push({ hash, size: bytes.length })
    }
    const entry = WorkspaceTree.Entry.parse({
      path: change.path,
      kind: "file",
      mode: change.mode ?? previous?.mode ?? 0o644,
      hash: WorkspaceTree.hash(change.data),
      size: change.data.length,
      chunks,
    })
    const entries = tree.entries.filter((item) => item.path !== change.path)
    let parent = path.posix.dirname(change.path)
    while (parent !== ".") {
      const existing = entries.find((item) => item.path === parent)
      if (existing && existing.kind !== "directory") throw new Error("Workspace parent is not a directory")
      if (!existing) entries.push({ kind: "directory", path: parent, mode: 0o755 })
      parent = path.posix.dirname(parent)
    }
    return prepare(info, store, { version: 1, entries: [...entries, entry] })
  }

  export async function write(input: Selection, change: Parameters<typeof prepareWrite>[1]) {
    const prepared = await prepareWrite(input, change)
    return WorkspaceCatalog.publishContent(prepared.info, prepared.manifest)
  }

  export async function prepareChange(input: Selection, raw: WorkspaceProtocol.Change, protectSensitive?: boolean) {
    const change = WorkspaceProtocol.Change.parse(raw)
    const { info, store } = await resolve(input)
    const tree = await manifest(info, store)
    const from = WorkspaceTree.resolve(
      tree,
      "path" in change ? change.path : change.kind === "import" ? change.to : change.from,
      false,
    )
    if (protectSensitive) protectedPath(from.path)
    const entries = new Map(tree.entries.map((entry) => [entry.path, entry]))
    const conflict = () => new WorkspaceErrors.ConflictError()
    const parents = (filename: string, create: boolean) => {
      const missing: string[] = []
      for (let name = path.posix.dirname(filename); name !== "."; name = path.posix.dirname(name)) {
        const parent = entries.get(name)
        if (!parent) {
          if (!create) throw new Error("Workspace parent directory is absent")
          missing.push(name)
        } else if (parent.kind !== "directory" || !(parent.mode & 0o222))
          throw new Error("Workspace parent is not a writable directory")
      }
      for (const name of missing) entries.set(name, { kind: "directory", path: name, mode: 0o755 })
    }
    if (change.kind === "replace") {
      if (
        (from.entry ? WorkspaceTree.entryVersion(from.entry, info.content?.revision) : null) !== change.expectedVersion
      )
        throw conflict()
      if (from.entry?.kind === "directory" || (from.entry?.kind === "file" && !(from.entry.mode & 0o222)))
        throw new WorkspaceErrors.AccessDeniedError("Workspace entry cannot be replaced")
      if (
        change.expectedContentVersion !== undefined &&
        (from.entry?.kind !== "file" || `sha256:${from.entry.hash}` !== change.expectedContentVersion)
      )
        throw conflict()
      const data = Buffer.from(change.data, "base64")
      if (data.toString("base64") !== change.data || data.length > WorkspaceProtocol.writeBytes)
        throw new Error("Invalid replacement bytes")
      parents(from.path, true)
      if (change.mode === "120000")
        entries.set(from.path, {
          kind: "symlink",
          path: from.path,
          mode: 0o777,
          target: SnapshotLink.decode(data).target,
        })
      else {
        const chunks = []
        for (let offset = 0; offset < data.length; offset += WorkspaceTree.chunkBytes) {
          const bytes = data.subarray(offset, offset + WorkspaceTree.chunkBytes)
          const hash = WorkspaceTree.hash(bytes)
          await store.put(hash, bytes)
          chunks.push({ hash, size: bytes.length })
        }
        entries.set(from.path, {
          kind: "file",
          path: from.path,
          mode: change.mode === "100755" ? 0o755 : 0o644,
          hash: WorkspaceTree.hash(data),
          size: data.length,
          chunks,
        })
      }
    } else if (change.kind === "import") {
      if (from.entry) throw conflict()
      const bytes = WorkspaceTree.verify(
        change.manifest,
        await store.get(change.manifest, WorkspaceTree.manifestBytes),
        WorkspaceTree.manifestBytes,
      )
      const incoming = WorkspaceTree.importEntries(JSON.parse(new TextDecoder().decode(bytes)), from.path)
      for (const entry of incoming) {
        if (protectSensitive) protectedPath(entry.path)
        entries.set(entry.path, entry)
      }
      parents(from.path, true)
    } else if (change.kind === "mkdir") {
      if (from.entry) throw conflict()
      parents(from.path, change.createParents ?? false)
      entries.set(from.path, { kind: "directory", path: from.path, mode: change.mode ?? 0o755 })
    } else {
      if (!from.entry || WorkspaceTree.entryVersion(from.entry, info.content?.revision) !== change.expectedVersion)
        throw conflict()
      const members = tree.entries.filter((entry) => entry.path === from.path || entry.path.startsWith(`${from.path}/`))
      if (protectSensitive) for (const entry of members) protectedPath(entry.path)
      if (change.kind === "remove") {
        if (!change.recursive && members.length > 1)
          throw new Error("Directory is not empty; recursive removal is required")
        parents(from.path, false)
        for (const entry of members) entries.delete(entry.path)
      } else {
        const to = WorkspaceTree.resolve(tree, change.to, false)
        if (to.entry) throw conflict()
        if (from.path.startsWith(`${to.path}/`) || to.path.startsWith(`${from.path}/`))
          throw new Error("Source and destination must be separate filesystem entries")
        parents(to.path, false)
        if (change.kind === "move") {
          parents(from.path, false)
          for (const entry of members) entries.delete(entry.path)
        }
        for (const entry of members) {
          const name = to.path + entry.path.slice(from.path.length)
          if (protectSensitive) protectedPath(name)
          entries.set(name, { ...entry, path: name })
        }
      }
    }
    return prepare(info, store, { version: 1, entries: [...entries.values()] })
  }

  export async function mutate(input: Selection, change: WorkspaceProtocol.Change) {
    const prepared = await prepareChange(input, change)
    return WorkspaceCatalog.publishContent(prepared.info, prepared.manifest)
  }

  function protectedPath(filename: string) {
    if (SensitivePathPolicy.classifyRelative(filename).matched)
      throw new WorkspaceErrors.AccessDeniedError("Access denied: protected filesystem entry")
  }

  async function prepare(info: WorkspaceCatalog.Info, store: BlobStore, tree: WorkspaceTree.Manifest) {
    const bytes = WorkspaceTree.encode(tree)
    const manifest = WorkspaceTree.hash(bytes)
    await store.put(manifest, bytes)
    return { info, manifest }
  }

  export async function publish(info: WorkspaceCatalog.Info, store: BlobStore, tree: WorkspaceTree.Manifest) {
    const bytes = WorkspaceTree.encode(tree)
    const hash = WorkspaceTree.hash(bytes)
    await store.put(hash, bytes)
    return WorkspaceCatalog.publishContent(info, hash)
  }
}
