import { createHash } from "node:crypto"
import path from "node:path"
import { z } from "zod"

export namespace WorkspaceTree {
  export function importEntries(raw: unknown, destination: string): Entry[] {
    Path.parse(destination)
    const tree = Manifest.parse(raw)
    if (!tree.entries.some((entry) => entry.path === "entry")) throw new Error("Transfer has no root entry")
    for (const entry of tree.entries) {
      if (entry.path !== "entry" && !entry.path.startsWith("entry/"))
        throw new Error("Transfer entry escaped its source")
      if (entry.kind === "symlink") {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(entry.path), entry.target))
        if (target !== "entry" && !target.startsWith("entry/")) throw new Error("Transfer link escaped its source")
      }
    }
    return tree.entries.map((entry) => ({ ...entry, path: destination + entry.path.slice("entry".length) }))
  }
  export const chunkBytes = 4 * 1024 * 1024
  export const manifestBytes = 64 * 1024 * 1024
  export const Hash = z.string().regex(/^[a-f0-9]{64}$/)
  export const Path = z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (value) =>
        !value.includes("\\") &&
        !/[\x00-\x1f]/.test(value) &&
        !value.startsWith("/") &&
        !value.split("/").some((part) => !part || part === "." || part === "..") &&
        !/^[a-zA-Z]:/.test(value),
      "Expected a relative Workspace path",
    )
  const Mode = z.number().int().min(0).max(0o777)
  export const Chunk = z.object({ hash: Hash, size: z.number().int().min(0).max(chunkBytes) })
  export const Entry = z.discriminatedUnion("kind", [
    z.object({
      path: Path,
      kind: z.literal("file"),
      mode: Mode,
      size: z.number().int().nonnegative(),
      hash: Hash,
      chunks: z.array(Chunk).max(1_000_000),
    }),
    z.object({ path: Path, kind: z.literal("directory"), mode: Mode }),
    z.object({ path: Path, kind: z.literal("symlink"), mode: Mode, target: z.string().min(1).max(4096) }),
  ])
  export type Entry = z.infer<typeof Entry>
  export const Manifest = z
    .object({ version: z.literal(1), entries: z.array(Entry).max(100_000) })
    .superRefine((value, context) => {
      const seen = new Map<string, Entry>()
      for (const entry of value.entries) {
        if (seen.has(entry.path)) context.addIssue({ code: "custom", message: "Duplicate Workspace path" })
        seen.set(entry.path, entry)
        if (entry.kind === "file" && entry.chunks.reduce((size, chunk) => size + chunk.size, 0) !== entry.size)
          context.addIssue({ code: "custom", message: "File chunk lengths do not match its size" })
        if (entry.kind === "symlink") {
          const resolved = path.posix.join(path.posix.dirname(entry.path), entry.target)
          if (
            entry.target.startsWith("/") ||
            entry.target.includes("\\") ||
            /[\x00-\x1f]/.test(entry.target) ||
            /^[a-zA-Z]:/.test(entry.target) ||
            resolved === ".." ||
            resolved.startsWith("../")
          )
            context.addIssue({ code: "custom", message: "Workspace link escapes its root" })
        }
      }
      for (const entry of value.entries) {
        const parent = path.posix.dirname(entry.path)
        if (parent !== "." && seen.get(parent)?.kind !== "directory")
          context.addIssue({ code: "custom", message: "Workspace parent is absent or is not a directory" })
      }
    })
  export type Manifest = z.infer<typeof Manifest>
  const indexes = new WeakMap<Manifest, { entries: Map<string, Entry>; children: Map<string, Entry[]> }>()
  function index(manifest: Manifest) {
    const previous = indexes.get(manifest)
    if (previous) return previous
    const entries = new Map(manifest.entries.map((entry) => [entry.path, entry]))
    const children = new Map<string, Entry[]>()
    for (const entry of manifest.entries) {
      const parent = path.posix.dirname(entry.path)
      const key = parent === "." ? "" : parent
      const values = children.get(key) ?? []
      values.push(entry)
      children.set(key, values)
    }
    const result = { entries, children }
    if (Object.isFrozen(manifest) && Object.isFrozen(manifest.entries)) {
      for (const values of children.values()) Object.freeze(values)
      indexes.set(manifest, result)
    }
    return result
  }
  export function children(manifest: Manifest, directory: string): readonly Entry[] {
    return index(manifest).children.get(directory) ?? []
  }

  export function resolve(
    manifest: Manifest,
    filename: string,
    followFinal = true,
  ): { path: string; entry: Entry | undefined } {
    if (filename) Path.parse(filename)
    const entries = index(manifest).entries
    for (let links = 0; links <= 40; links++) {
      const parts = filename.split("/")
      let redirected = false
      for (let index = 0; index < parts.length; index++) {
        const name = parts.slice(0, index + 1).join("/")
        const entry = entries.get(name)
        if (entry?.kind !== "symlink" || (!followFinal && index === parts.length - 1)) continue
        filename = path.posix.join(path.posix.dirname(name), entry.target, ...parts.slice(index + 1))
        if (filename === ".") filename = ""
        if (filename) Path.parse(filename)
        redirected = true
        break
      }
      if (!redirected) return { path: filename, entry: entries.get(filename) }
    }
    throw new Error("Workspace symbolic link cycle")
  }

  export function entryVersion(entry: Entry, revision?: number) {
    return `entry:${hash(new TextEncoder().encode(JSON.stringify([entry, revision])))}`
  }

  export function hash(bytes: Uint8Array) {
    return createHash("sha256").update(bytes).digest("hex")
  }

  export function encode(manifest: Manifest) {
    const value = Manifest.parse(manifest)
    value.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    if (bytes.byteLength > manifestBytes) throw new Error("Workspace manifest exceeds its size limit")
    return bytes
  }

  export function verify(hash: string, bytes: Uint8Array, maximum = chunkBytes) {
    Hash.parse(hash)
    if (bytes.byteLength > maximum || WorkspaceTree.hash(bytes) !== hash)
      throw new Error("Workspace object integrity check failed")
    return bytes
  }
}
