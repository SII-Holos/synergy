import { z } from "zod"
import { posix } from "node:path"
import { createHash } from "node:crypto"
import { SessionTransferStream as Stream } from "../session/transfer-stream"
import type { BlobStore } from "../storage/blobs"
import { WorkspaceTree } from "./tree"

export namespace WorkspacePortableTree {
  const Mode = z.number().int().min(0).max(0o777)
  const emptyHash = createHash("sha256").digest("hex")
  export const Metadata = z.discriminatedUnion("kind", [
    z.strictObject({ version: z.literal(1), kind: z.literal("file"), mode: Mode }),
    z.strictObject({ version: z.literal(1), kind: z.literal("directory"), mode: Mode }),
    z.strictObject({
      version: z.literal(1),
      kind: z.literal("symlink"),
      mode: Mode,
      target: z.string().min(1).max(4096),
    }),
  ])
  export type Metadata = z.infer<typeof Metadata>
  export const Root = z
    .strictObject({ version: z.literal(1), mode: Mode, tree: Stream.Root })
    .refine(
      (value) => Object.keys(value.tree.owners).length === 1 && value.tree.owners["workspace-files"] === 1,
      "Portable Workspace files require their own versioned owner",
    )
  export type Root = z.infer<typeof Root>
  export type Entry = WorkspaceTree.Header

  export function reference(entry: Entry, chunks: Stream.Reference["chunks"]): Stream.Reference {
    const metadata = Metadata.parse(
      entry.kind === "symlink"
        ? { version: 1, kind: entry.kind, mode: entry.mode, target: entry.target }
        : { version: 1, kind: entry.kind, mode: entry.mode },
    )
    return {
      id: path(entry.path, metadata),
      kind: entry.kind === "file" ? "file" : "record",
      metadata,
      bytes: entry.kind === "file" ? entry.size : 0,
      hash: entry.kind === "file" ? entry.hash : emptyHash,
      chunks,
    }
  }

  function describe(entry: Stream.Descriptor): Entry {
    const metadata = Metadata.parse(entry.metadata)
    const relative = path(entry.id, metadata)
    if (entry.kind !== (metadata.kind === "file" ? "file" : "record"))
      throw new Error("Portable Workspace entry has another native kind")
    if (metadata.kind === "file")
      return { path: relative, kind: "file", mode: metadata.mode, size: entry.bytes, hash: entry.hash }
    if (entry.bytes !== 0 || entry.hash !== emptyHash)
      throw new Error("Portable Workspace metadata carries unexpected bytes")
    return metadata.kind === "directory"
      ? { path: relative, kind: "directory", mode: metadata.mode }
      : { path: relative, kind: "symlink", mode: metadata.mode, target: metadata.target }
  }

  export async function open(input: { root: Root; store: BlobStore; directory: string; signal?: AbortSignal }) {
    const selected = Root.parse(input.root)
    const reader = await Stream.open({ ...input, root: selected.tree })
    try {
      const index = await reader.index()
      const root = Object.freeze({ ...selected, tree: index.root })
      async function get(filename: string) {
        const entry = await index.get(filename)
        return entry ? describe(entry) : undefined
      }
      for await (const value of index.entries()) {
        const entry = describe(value)
        const parent = posix.dirname(entry.path)
        if (parent !== "." && (await get(parent))?.kind !== "directory")
          throw new Error("Portable Workspace parent is absent or is not a directory")
      }
      async function resolve(
        filename: string,
        followFinal = true,
      ): Promise<{ path: string; entry: Entry | undefined }> {
        if (filename) WorkspaceTree.Path.parse(filename)
        for (let links = 0; links <= 40; links++) {
          const parts = filename.split("/")
          let redirected = false
          for (let position = 0; position < parts.length; position++) {
            const name = parts.slice(0, position + 1).join("/")
            const entry = await get(name)
            if (entry?.kind !== "symlink" || (!followFinal && position === parts.length - 1)) continue
            filename = posix.join(posix.dirname(name), entry.target, ...parts.slice(position + 1))
            if (filename === ".") filename = ""
            if (filename) WorkspaceTree.Path.parse(filename)
            redirected = true
            break
          }
          if (!redirected) return { path: filename, entry: await get(filename) }
        }
        throw new Error("Portable Workspace symbolic link cycle")
      }
      function entries(options: { prefix?: string; after?: string } = {}) {
        const source = index.entries(options)
        return (async function* () {
          for await (const entry of source) yield describe(entry)
        })()
      }
      function references(options: { prefix?: string; after?: string } = {}) {
        return (async function* () {
          for await (const entry of index.entries(options)) yield reference(describe(entry), index.chunks(entry.id))
        })()
      }
      function children(directory: string) {
        if (directory) WorkspaceTree.Path.parse(directory)
        return (async function* () {
          if (directory && (await get(directory))?.kind !== "directory") return
          const prefix = directory ? directory + "/" : ""
          let from = prefix
          let after: string | undefined
          for (;;) {
            const source = index.entries({ prefix, from, after })
            const next = await source.next()
            await source.return(undefined)
            if (next.done) return
            const entry = describe(next.value)
            after = entry.path
            // "0" is the exclusive upper bound of the descendant "/" prefix in SQLite's binary order.
            if (entry.kind === "directory") from = entry.path + "0"
            yield entry
          }
        })()
      }
      function read(filename: string, options: { offset?: number; length?: number } = {}) {
        const range = { offset: options.offset, length: options.length }
        return (async function* () {
          const { entry } = await resolve(filename)
          if (entry?.kind !== "file") throw new Error("Portable Workspace file is absent or is not a regular file")
          for await (const bytes of index.read(entry.path, range)) yield bytes
        })()
      }
      return Object.freeze({
        root,
        get,
        resolve,
        entries,
        references,
        children,
        read,
        objects: index.objects,
        close: reader.close,
        [Symbol.asyncDispose]: reader.close,
      })
    } catch (error) {
      await reader.close()
      throw error
    }
  }

  export function path(value: string, metadata: Metadata) {
    WorkspaceTree.Path.parse(value)
    if (metadata.kind === "symlink")
      WorkspaceTree.Manifest.parse({
        version: 1,
        entries: [
          ...value
            .split("/")
            .slice(0, -1)
            .map((_part, index, parts) => ({
              kind: "directory" as const,
              path: parts.slice(0, index + 1).join("/"),
              mode: 0o755,
            })),
          { path: value, ...metadata },
        ],
      })
    return value
  }
}
