import path from "node:path"
import fs from "node:fs/promises"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { EnvironmentResources } from "@ericsanchezok/synergy-harness/environment/resources"
import { WorkspaceContent, type BlobStore } from "@ericsanchezok/synergy-harness/workspace/content"
import { WorkspaceCatalog } from "@ericsanchezok/synergy-harness/workspace"
import { WorkspaceMounts } from "@ericsanchezok/synergy-harness/workspace/mount"
import { WorkspaceOperations } from "@ericsanchezok/synergy-harness/workspace/operations"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import type { WorkspaceProtocol } from "@ericsanchezok/synergy-harness/workspace/protocol"
import { NativeFileMutation } from "./mutation-core"
import { NativeFileEntry } from "./entry-core"

export namespace FileView {
  export const native = EnvironmentResources.localFiles

  export function directory() {
    if (native()) return EnvironmentResources.current()?.directory ?? ScopeContext.current.directory
    return EnvironmentResources.current()?.directory ?? ""
  }

  export async function searchRoots(input?: string) {
    if (input !== undefined || !native()) return [resolve(input ?? ".")]
    const roots = await Scope.Root.executionRoots(ScopeContext.current.scope, ScopeContext.current.workspace)
    return roots.length ? roots : [resolve(".")]
  }

  function paths() {
    return native() ? path : EnvironmentResources.current()?.runtime?.platform === "win32" ? path.win32 : path.posix
  }

  export function relative(filename: string): string {
    const api = paths()
    if (native()) {
      const absolute = resolve(filename)
      return path
        .relative(
          EnvironmentResources.current()?.directory ?? ScopeContext.tryWorkspace()?.path ?? path.dirname(absolute),
          absolute,
        )
        .replaceAll("\\", "/")
    }
    const root = directory()
    const candidate = root && api.isAbsolute(filename) ? api.relative(root, filename) : filename
    if (!candidate || candidate === ".") return ""
    return WorkspaceTree.Path.parse(api.normalize(candidate).replaceAll(api.sep, "/").replace(/\/$/, ""))
  }

  export function resolve(filename: string, base = directory()): string {
    if (native()) return path.isAbsolute(filename) ? path.normalize(filename) : path.resolve(base, filename)
    const name = relative(paths().isAbsolute(filename) ? filename : paths().join(base, filename))
    return directory() ? paths().join(directory(), name) : name
  }

  export function dirname(filename: string) {
    return resolve(paths().dirname(filename))
  }

  export async function canonical(filename: string, follow = true) {
    if (native())
      return follow ? NativeFileMutation.canonical(resolve(filename)) : NativeFileEntry.canonical(resolve(filename))
    const info = await selected()
    const name = relative(filename)
    if (info.activeMount)
      return resolve(
        await (await WorkspaceMounts.connect(info)).canonical(WorkspaceMounts.reference(info), name, follow),
      )
    const { store } = await WorkspaceContent.resolve(selection(info))
    return resolve(WorkspaceTree.resolve(await WorkspaceContent.manifest(info, store), name, follow).path)
  }

  export function display(filename: string) {
    const rel = relative(filename)
    return rel && !rel.startsWith("..") ? rel : filename
  }

  async function selected() {
    const selected = EnvironmentResources.current()?.workspace
    if (!selected) throw new Error("File operation requires a selected Workspace")
    const latest = await WorkspaceCatalog.get(selected.id, selected.scopeID)
    if (latest.lifecycle !== "active" || latest.binding.state !== "bound")
      throw new WorkspaceCatalog.Unavailable({
        workspaceID: selected.id,
        message: "Workspace has no active storage authority",
      })
    if (latest.binding.generation !== selected.binding.generation)
      throw new WorkspaceCatalog.BindingChanged({ workspaceID: selected.id, message: "Workspace binding changed" })
    if (
      latest.activeMount?.id !== selected.activeMount?.id ||
      latest.activeMount?.state !== selected.activeMount?.state
    )
      throw new WorkspaceCatalog.BindingChanged({ workspaceID: selected.id, message: "Workspace live view changed" })
    return latest
  }

  function selection(info: WorkspaceCatalog.Info) {
    return { workspaceID: info.id, scopeID: info.scopeID, generation: info.binding.generation }
  }

  export async function stat(filename: string, follow = false): Promise<WorkspaceProtocol.Item | undefined> {
    if (native()) {
      const entry = await NativeFileEntry.inspect(
        follow ? await NativeFileMutation.canonical(resolve(filename)) : resolve(filename),
      )
      if (!entry) return
      return {
        path: relative(filename),
        entryVersion: entry.version,
        kind: entry.type,
        size: Number(entry.stat.size),
        mode: Number(entry.stat.mode & 0o777n),
        mtime: Number(entry.stat.mtimeNs) / 1e6,
        ctime: Number(entry.stat.ctimeNs) / 1e6,
      }
    }
    const info = await selected()
    const name = relative(filename)
    if (info.activeMount)
      return (await WorkspaceMounts.connect(info)).stat(WorkspaceMounts.reference(info), name, follow)
    const { store } = await WorkspaceContent.resolve(selection(info))
    const tree = await WorkspaceContent.manifest(info, store)
    const resolved = WorkspaceTree.resolve(tree, name, follow)
    const entry = resolved.path ? resolved.entry : { kind: "directory" as const, path: "", mode: 0o755 }
    return entry ? item(info, entry, name) : undefined
  }

  function item(info: WorkspaceCatalog.Info, entry: WorkspaceTree.Entry, filename: string): WorkspaceProtocol.Item {
    return {
      path: filename,
      kind: entry.kind,
      entryVersion: WorkspaceTree.entryVersion(entry, info.content?.revision),
      mode: entry.mode,
      size: entry.kind === "file" ? entry.size : 0,
      mtime: info.updatedAt,
      ctime: info.createdAt,
    }
  }

  export async function list(filename = ""): Promise<WorkspaceProtocol.Item[]> {
    if (native()) {
      const result: WorkspaceProtocol.Item[] = []
      for (const name of (await fs.readdir(resolve(filename))).sort()) {
        const entry = await stat(path.join(resolve(filename), name))
        if (entry) result.push(entry)
      }
      return result
    }
    const info = await selected()
    const name = relative(filename)
    if (info.activeMount) return (await WorkspaceMounts.connect(info)).list(WorkspaceMounts.reference(info), name)
    const { store } = await WorkspaceContent.resolve(selection(info))
    const tree = await WorkspaceContent.manifest(info, store)
    const directory = WorkspaceTree.resolve(tree, name)
    if (directory.path && directory.entry?.kind !== "directory") throw new Error("Workspace path is not a directory")
    return WorkspaceTree.children(tree, directory.path).map((entry) =>
      item(info, entry, name ? `${name}/${path.posix.basename(entry.path)}` : entry.path),
    )
  }

  export async function bytes(
    filename: string,
    range?: { offset: number; length: number },
    maximumBytes = 64 * 1024 * 1024,
  ): Promise<Uint8Array> {
    if (native()) {
      const file = Bun.file(resolve(filename))
      const size = (await file.stat()).size
      if (Math.min(range?.length ?? size, size) > maximumBytes) throw new Error("Workspace file exceeds the read limit")
      return range ? file.slice(range.offset, range.offset + range.length).bytes() : file.bytes()
    }
    const info = await selected()
    const name = relative(filename)
    if (!info.activeMount) {
      if (!range) return WorkspaceContent.read(selection(info), name, maximumBytes)
      if (range.length > maximumBytes) throw new Error("Workspace file exceeds the read limit")
      const first = await WorkspaceContent.readRange(
        selection(info),
        name,
        range.offset,
        Math.min(range.length, WorkspaceTree.chunkBytes),
      )
      const length = Math.min(range.length, Math.max(0, first.size - range.offset))
      const result = new Uint8Array(length)
      result.set(first.bytes)
      for (let offset = first.bytes.length; offset < length; ) {
        const next = await WorkspaceContent.readRange(
          selection(info),
          name,
          range.offset + offset,
          Math.min(length - offset, WorkspaceTree.chunkBytes),
        )
        if (next.version !== first.version || !next.bytes.length) throw new NativeFileMutation.ConflictError()
        result.set(next.bytes, offset)
        offset += next.bytes.length
      }
      return result
    }
    const files = await WorkspaceMounts.connect(info)
    const mount = WorkspaceMounts.reference(info)
    const chunks: Uint8Array[] = []
    const offset = range?.offset ?? 0
    const first = await files.read({
      mount,
      path: name,
      offset,
      maximumBytes: Math.min(range?.length ?? maximumBytes, WorkspaceTree.chunkBytes),
    })
    const length = Math.min(range?.length ?? first.size, Math.max(0, first.size - offset))
    if (length > maximumBytes) throw new Error("Workspace file exceeds the read limit")
    chunks.push(Buffer.from(first.data, "base64"))
    let read = chunks[0]!.length
    while (read < length) {
      const next = await files.read({
        mount,
        path: name,
        offset: offset + read,
        maximumBytes: Math.min(length - read, WorkspaceTree.chunkBytes),
        expectedVersion: first.version,
      })
      const data = Buffer.from(next.data, "base64")
      if (!data.length) throw new Error("Workspace file read is incomplete")
      chunks.push(data)
      read += data.length
    }
    return Buffer.concat(chunks, read)
  }

  export async function write(
    filename: string,
    data: Uint8Array,
    expectedVersion: string | null,
    signal?: AbortSignal,
    protectSensitive?: boolean,
  ) {
    signal?.throwIfAborted()
    const info = await selected()
    const name = relative(filename)
    await WorkspaceOperations.write({
      ...selection(info),
      id: EnvironmentResources.nextOperationID(),
      path: name,
      data,
      expectedVersion,
      signal,
      protectSensitive,
    })
    return {
      mtime: Date.now(),
      size: data.byteLength,
      existed: expectedVersion !== null,
      contentVersion: `sha256:${WorkspaceTree.hash(data)}`,
    }
  }

  export async function importTree(
    filename: string,
    capture: (store: BlobStore) => Promise<WorkspaceTree.Manifest>,
    signal?: AbortSignal,
  ) {
    const info = await selected()
    const files = info.activeMount ? await WorkspaceMounts.connect(info) : undefined
    const store: BlobStore = files
      ? { get: (hash, limit) => files.getBlob(hash, limit), put: (hash, bytes) => files.putBlob(hash, bytes) }
      : (await WorkspaceContent.resolve(selection(info))).store
    const tree = await capture(store)
    const bytes = WorkspaceTree.encode(tree)
    const manifest = WorkspaceTree.hash(bytes)
    await store.put(manifest, bytes)
    await mutate({ kind: "import", to: relative(filename), manifest }, signal, true)
  }

  export async function mutate(change: WorkspaceProtocol.Change, signal?: AbortSignal, protectSensitive?: boolean) {
    const info = await selected()
    await WorkspaceOperations.mutate({
      ...selection(info),
      id: EnvironmentResources.nextOperationID(),
      change,
      signal,
      protectSensitive,
    })
  }

  export function file(filename: string) {
    const read = (range?: { offset: number; length: number }) => ({
      bytes: () => bytes(filename, range),
      text: async () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await bytes(filename, range)),
      arrayBuffer: async () => new Uint8Array(await bytes(filename, range)).buffer,
    })
    return {
      ...read(),
      type: Bun.file(filename).type,
      exists: async () => !!(await stat(filename)),
      async stat() {
        const entry = await stat(filename, true)
        if (!entry) throw Object.assign(new Error(`File not found: ${filename}`), { code: "ENOENT" })
        return {
          size: entry.size,
          mode: entry.mode,
          mtimeMs: entry.mtime,
          ctimeMs: entry.ctime,
          isDirectory: () => entry.kind === "directory",
          isFile: () => entry.kind === "file",
          isSymbolicLink: () => entry.kind === "symlink",
        }
      },
      slice: (start: number, end: number) => read({ offset: start, length: Math.max(0, end - start) }),
    }
  }
}
