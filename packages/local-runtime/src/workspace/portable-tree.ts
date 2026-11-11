import fs from "node:fs/promises"
import { constants, type BigIntStats } from "node:fs"
import path from "node:path"
import { Database } from "bun:sqlite"
import { SessionTransferStream as Stream } from "@ericsanchezok/synergy-harness/session/transfer"
import { initializeSqliteEngine } from "@ericsanchezok/synergy-harness/storage/sqlite-engine"
import { WorkspacePortableTree as Portable } from "@ericsanchezok/synergy-harness/workspace/portable-tree"
import type { BlobStore } from "@ericsanchezok/synergy-harness/storage/blobs"
import { SensitivePathPolicy } from "@ericsanchezok/synergy-harness/enforcement/sensitive-path"

export namespace NativeWorkspacePortableTree {
  interface Options {
    root: string
    directory: string
    store: BlobStore
    signal?: AbortSignal
  }
  interface Row {
    path: string
    identity: string
    metadata: string
    visited: number
  }
  const identity = (stat: BigIntStats) =>
    [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")
  const filename = (root: string, relative: string) => (relative ? path.join(root, ...relative.split("/")) : root)
  const empty = async function* () {}
  async function outside(root: string, directory: string) {
    let current = path.resolve(directory)
    const suffix: string[] = []
    for (;;) {
      try {
        const canonical = path.join(await fs.realpath(current), ...suffix.reverse())
        if (canonical === root || canonical.startsWith(root + path.sep))
          throw new Error("Portable Workspace cache overlaps its files")
        return
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
        suffix.push(path.basename(current))
        const parent = path.dirname(current)
        if (parent === current) throw error
        current = parent
      }
    }
  }
  async function temporary(directory: string) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    return fs.mkdtemp(path.join(await fs.realpath(directory), "workspace-tree-"))
  }
  async function metadata(file: string, stat: BigIntStats): Promise<Portable.Metadata> {
    const mode = Number(stat.mode & 0o777n)
    if (stat.isDirectory()) return { version: 1, kind: "directory", mode }
    if (stat.isFile()) return { version: 1, kind: "file", mode }
    if (stat.isSymbolicLink()) return { version: 1, kind: "symlink", mode, target: await fs.readlink(file) }
    throw new Error("Portable Workspace cannot preserve a special file")
  }
  async function* content(file: string, expected: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const handle = await fs.open(
      file,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
    )
    try {
      if (identity(await handle.stat({ bigint: true })) !== expected)
        throw new Error("Workspace changed during capture")
      const buffer = new Uint8Array(Stream.chunkBytes)
      for (;;) {
        signal?.throwIfAborted()
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
        if (!bytesRead) break
        yield buffer.subarray(0, bytesRead)
      }
      if (identity(await handle.stat({ bigint: true })) !== expected)
        throw new Error("Workspace changed during capture")
    } finally {
      await handle.close()
    }
  }
  export async function capture(options: Options): Promise<Portable.Root> {
    const { directory, store, signal } = options
    const root = path.resolve(options.root)
    signal?.throwIfAborted()
    if ((await fs.realpath(root)) !== root) throw new Error("Portable Workspace requires its canonical root")
    const initial = await fs.lstat(root, { bigint: true })
    if (!initial.isDirectory() || initial.isSymbolicLink())
      throw new Error("Portable Workspace requires a native directory")
    await outside(root, directory)
    await initializeSqliteEngine()
    const cache = await temporary(directory)
    if (cache === root || root.startsWith(cache + path.sep) || cache.startsWith(root + path.sep)) {
      await fs.rm(cache, { recursive: true, force: true })
      throw new Error("Portable Workspace cache overlaps its files")
    }
    let database: Database | undefined
    try {
      database = new Database(path.join(cache, "inventory.sqlite"))
      const inventory = database
      database.exec(
        "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE entries(path TEXT PRIMARY KEY,identity TEXT NOT NULL,metadata TEXT NOT NULL,visited INTEGER NOT NULL)",
      )
      using insert = database.prepare("INSERT INTO entries VALUES(?,?,?,?)")
      using next = database.prepare<Row, []>("SELECT * FROM entries WHERE visited=0 ORDER BY path LIMIT 1")
      using visit = database.prepare("UPDATE entries SET visited=1 WHERE path=?")
      insert.run("", identity(initial), JSON.stringify(await metadata(root, initial)), 0)
      for (;;) {
        signal?.throwIfAborted()
        const row = next.get()
        if (!row) break
        const current = filename(root, row.path)
        const children = await fs.opendir(current)
        for await (const child of children) {
          signal?.throwIfAborted()
          const relative = row.path ? row.path + "/" + child.name : child.name
          const selected = filename(root, relative)
          const stat = await fs.lstat(selected, { bigint: true })
          const value = await metadata(selected, stat)
          Portable.path(relative, value)
          const sensitive = SensitivePathPolicy.classifyRelative(relative)
          if (sensitive.matched && !sensitive.smartAllowEligible)
            throw new Error(
              sensitive.kind === "vcs"
                ? "Portable Workspace requires its Git adapter"
                : "Portable Workspace contains a credential or control path",
            )
          insert.run(relative, identity(stat), JSON.stringify(value), value.kind === "directory" ? 0 : 1)
        }
        visit.run(row.path)
      }
      async function* entries(): AsyncGenerator<Stream.Input> {
        using rows = inventory.prepare<Row, [string]>("SELECT * FROM entries WHERE path>? ORDER BY path LIMIT 1")
        let after = ""
        for (;;) {
          signal?.throwIfAborted()
          const row = rows.get(after)
          if (!row) break
          after = row.path
          const value = Portable.Metadata.parse(JSON.parse(row.metadata))
          yield {
            id: row.path,
            kind: value.kind === "file" ? "file" : "record",
            metadata: value,
            content: value.kind === "file" ? content(filename(root, row.path), row.identity, signal) : empty(),
          }
        }
      }
      async function verify() {
        using rows = inventory.prepare<Row, []>("SELECT * FROM entries ORDER BY path")
        for (const row of rows.iterate()) {
          signal?.throwIfAborted()
          if (identity(await fs.lstat(filename(root, row.path), { bigint: true })) !== row.identity)
            throw new Error("Workspace changed during capture")
        }
      }
      await verify()
      const tree = await Stream.write({ store, entries: entries(), owners: { "workspace-files": 1 }, signal })
      await verify()
      return Portable.Root.parse({ version: 1, mode: Number(initial.mode & 0o777n), tree })
    } finally {
      database?.close(true)
      await fs.rm(cache, { recursive: true, force: true })
    }
  }
  async function syncDirectory(directory: string) {
    if (process.platform === "win32") return
    const handle = await fs.open(directory, constants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  async function filesystem(directory: string) {
    const lower = path.join(directory, "case-probe")
    const unicode = path.join(directory, "unicode-é")
    await fs.writeFile(lower, "", { flag: "wx" })
    await fs.writeFile(unicode, "", { flag: "wx" })
    try {
      const caseFold = await fs.lstat(path.join(directory, "CASE-PROBE")).then(
        () => true,
        (e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return false
          throw e
        },
      )
      const normalize = await fs.lstat(path.join(directory, "unicode-é")).then(
        () => true,
        (e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return false
          throw e
        },
      )
      return { caseFold, normalize }
    } finally {
      await fs.rm(lower)
      await fs.rm(unicode)
    }
  }
  export async function materialize(options: Options & { captured: Portable.Root }) {
    const { directory, store, signal } = options
    const captured = Portable.Root.parse(options.captured)
    const destination = path.resolve(options.root)
    signal?.throwIfAborted()
    const parent = await fs.realpath(path.dirname(destination))
    if (parent !== path.dirname(destination))
      throw new Error("Portable Workspace destination requires a canonical parent")
    const previous = await fs.lstat(destination, { bigint: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e
    })
    if (previous && (!previous.isDirectory() || previous.isSymbolicLink() || (await fs.readdir(destination)).length))
      throw new Error("Portable Workspace destination must be empty")
    await outside(destination, directory)
    await initializeSqliteEngine()
    const cache = await temporary(directory)
    let staged: string | undefined
    let database: Database | undefined
    let published = false
    try {
      staged = await fs.mkdtemp(path.join(parent, ".synergy-workspace-"))
      database = new Database(path.join(cache, "paths.sqlite"))
      const comparison = await filesystem(staged)
      database.exec(
        "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE paths(path TEXT PRIMARY KEY,comparison TEXT NOT NULL UNIQUE,kind TEXT NOT NULL,mode INTEGER NOT NULL,depth INTEGER NOT NULL)",
      )
      using insert = database.prepare("INSERT INTO paths VALUES(?,?,?,?,?)")
      using parentRow = database.prepare<{ kind: string }, [string]>("SELECT kind FROM paths WHERE path=?")
      await using reader = await Stream.open({ root: captured.tree, store, directory: cache, signal })
      for await (const entry of reader.entries()) {
        signal?.throwIfAborted()
        const value = Portable.Metadata.parse(entry.metadata)
        const relative = Portable.path(entry.id, value)
        if (entry.kind !== (value.kind === "file" ? "file" : "record"))
          throw new Error("Portable Workspace entry has another native kind")
        const parts = relative.split("/")
        if (
          process.platform === "win32" &&
          parts.some((name) => /[<>:"|?*]|[. ]$|^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
        )
          throw new Error("Portable Workspace path is not representable on this filesystem")
        const normalized = comparison.normalize ? relative.normalize("NFC") : relative
        const comparable = comparison.caseFold ? normalized.toLowerCase() : normalized
        try {
          insert.run(relative, comparable, value.kind, value.mode, parts.length)
        } catch (cause) {
          throw new Error("Portable Workspace has duplicate or filesystem-equivalent paths", { cause })
        }
        const parentPath = path.posix.dirname(relative)
        if (parentPath !== "." && parentRow.get(parentPath)?.kind !== "directory")
          throw new Error("Portable Workspace parent directory is absent or ambiguous")
        const file = filename(staged, relative)
        if (value.kind === "directory") await fs.mkdir(file, { mode: 0o700 })
        else if (value.kind === "symlink") await fs.symlink(value.target, file)
        else {
          const handle = await fs.open(file, "wx", 0o600)
          try {
            for await (const bytes of entry.content) {
              signal?.throwIfAborted()
              await handle.writeFile(bytes)
            }
            await handle.chmod(value.mode)
            await handle.sync()
          } finally {
            await handle.close()
          }
          continue
        }
        for await (const bytes of entry.content)
          if (bytes.byteLength) throw new Error("Portable Workspace metadata carries unexpected bytes")
      }
      if (!reader.verified()) throw new Error("Portable Workspace is incomplete")
      using directories = database.prepare<{ path: string; mode: number }, []>(
        "SELECT path,mode FROM paths WHERE kind='directory' ORDER BY depth DESC,path",
      )
      for (const row of directories.iterate()) {
        signal?.throwIfAborted()
        await fs.chmod(filename(staged, row.path), row.mode)
        await syncDirectory(filename(staged, row.path))
      }
      await fs.chmod(staged, captured.mode)
      await syncDirectory(staged)
      signal?.throwIfAborted()
      const current = await fs.lstat(destination, { bigint: true }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e
      })
      if ((current ? identity(current) : undefined) !== (previous ? identity(previous) : undefined))
        throw new Error("Portable Workspace destination changed during preparation")
      if (current) await fs.rmdir(destination)
      await fs.rename(staged, destination)
      published = true
      await syncDirectory(parent)
      return destination
    } finally {
      database?.close(true)
      await fs.rm(cache, { recursive: true, force: true })
      if (!published && staged) await fs.rm(staged, { recursive: true, force: true })
    }
  }
}
