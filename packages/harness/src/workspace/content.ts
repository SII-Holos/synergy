import path from "node:path"
import { z } from "zod"
import { RuntimeContext } from "../lifecycle/context"
import { WorkspaceCatalog } from "./catalog"
import { WorkspaceTree } from "./tree"
import { SensitivePathPolicy } from "../enforcement/sensitive-path"
import { WorkspaceErrors } from "./errors"
import { WorkspaceProtocol } from "./protocol"
import { SnapshotLink } from "../session/snapshot-link"

export interface BlobStore {
  put(hash: string, bytes: Uint8Array): Promise<void>
  get(hash: string, maximumBytes: number): Promise<Uint8Array>
}

export namespace WorkspaceBlobs {
  const stores = RuntimeContext.state(() => new Map<string, BlobStore>())
  export function register(id: string, store: BlobStore) {
    RuntimeContext.assertCompositionOpen("Workspace blob stores")
    if (stores().has(id)) throw new Error(`Duplicate Workspace blob store: ${id}`)
    stores().set(id, store)
  }
  export function get(id: string) {
    const store = stores().get(id)
    if (!store) throw new Error(`Workspace blob store is unavailable: ${id}`)
    return store
  }
}

export namespace WorkspaceContent {
  const cache = RuntimeContext.state(
    () => [] as Array<{ store: BlobStore; hash: string; bytes: number; tree: WorkspaceTree.Manifest }>,
  )
  export const Spec = z.object({ blobStore: z.string().min(1) }).strict()
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
    const store = WorkspaceBlobs.get(Spec.parse(info.backend.spec).blobStore)
    return { info, store }
  }

  export async function manifest(info: WorkspaceCatalog.Info, store: BlobStore): Promise<WorkspaceTree.Manifest> {
    if (!info.content?.manifest) return { version: 1, entries: [] }
    const entries = cache()
    const index = entries.findIndex((entry) => entry.store === store && entry.hash === info.content!.manifest)
    if (index !== -1) {
      const cached = entries.splice(index, 1)[0]!
      entries.push(cached)
      return cached.tree
    }
    const bytes = WorkspaceTree.verify(
      info.content.manifest,
      await store.get(info.content.manifest, WorkspaceTree.manifestBytes),
      WorkspaceTree.manifestBytes,
    )
    const tree = WorkspaceTree.Manifest.parse(JSON.parse(new TextDecoder().decode(bytes)))
    for (const entry of tree.entries) {
      if (entry.kind === "file") {
        for (const chunk of entry.chunks) Object.freeze(chunk)
        Object.freeze(entry.chunks)
      }
      Object.freeze(entry)
    }
    Object.freeze(tree.entries)
    Object.freeze(tree)
    entries.push({ store, hash: info.content.manifest, bytes: bytes.length, tree })
    while (entries.length > 8 || entries.reduce((total, entry) => total + entry.bytes, 0) > WorkspaceTree.manifestBytes)
      entries.shift()
    return tree
  }

  export async function read(
    input: Selection,
    filename: string,
    maximumBytes = WorkspaceTree.chunkBytes,
  ): Promise<Uint8Array> {
    WorkspaceTree.Path.parse(filename)
    const { info, store } = await resolve(input)
    const tree = await manifest(info, store)
    const entry = WorkspaceTree.resolve(tree, filename).entry
    if (!entry || entry.kind !== "file") throw new Error("Workspace file is absent or is not a regular file")
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || entry.size > maximumBytes)
      throw new Error("Workspace file exceeds the read limit")
    const bytes = new Uint8Array(entry.size)
    let offset = 0
    for (const chunk of entry.chunks) {
      const data = WorkspaceTree.verify(chunk.hash, await store.get(chunk.hash, chunk.size), chunk.size)
      if (data.byteLength !== chunk.size) throw new Error("Workspace file chunk is incomplete")
      bytes.set(data, offset)
      offset += data.length
    }
    return WorkspaceTree.verify(entry.hash, bytes, maximumBytes)
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
    const tree = await manifest(info, store)
    const entry = WorkspaceTree.resolve(tree, filename).entry
    if (!entry || entry.kind !== "file") throw new Error("Workspace file is absent or is not a regular file")
    const bytes = new Uint8Array(Math.min(length, Math.max(0, entry.size - offset)))
    let start = 0
    for (const chunk of entry.chunks) {
      const end = start + chunk.size
      if (end > offset && start < offset + bytes.length) {
        const data = WorkspaceTree.verify(chunk.hash, await store.get(chunk.hash, chunk.size), chunk.size)
        if (data.length !== chunk.size) throw new Error("Workspace file chunk is incomplete")
        const from = Math.max(offset, start)
        const to = Math.min(offset + bytes.length, end)
        bytes.set(data.subarray(from - start, to - start), from - offset)
      }
      start = end
    }
    return { bytes, version: `sha256:${entry.hash}`, size: entry.size, mode: entry.mode }
  }

  export async function prepareWrite(
    input: Selection,
    change: {
      path: string
      data: Uint8Array
      expectedVersion: string | null
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
