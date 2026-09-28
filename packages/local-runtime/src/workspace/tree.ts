import fs from "node:fs/promises"
import { constants, type BigIntStats } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { WorkspaceTree } from "@ericsanchezok/synergy-harness/workspace/tree"
import type { BlobStore } from "@ericsanchezok/synergy-harness/workspace/content"

export namespace NativeWorkspaceTree {
  function identity(stat: BigIntStats) {
    return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")
  }

  function filename(root: string, relative: string) {
    WorkspaceTree.Path.parse(relative)
    return path.join(root, ...relative.split("/"))
  }

  async function flushDirectory(directory: string) {
    if (process.platform === "win32") return
    const handle = await fs.open(directory, constants.O_RDONLY)
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  export async function capture(root: string, store: BlobStore, signal?: AbortSignal): Promise<WorkspaceTree.Manifest> {
    const canonical = await fs.realpath(root)
    const seen = new Map<string, string>()
    const entries: WorkspaceTree.Entry[] = []
    const directories = [""]
    while (directories.length) {
      signal?.throwIfAborted()
      const directory = directories.pop()!
      const absolute = directory ? filename(canonical, directory) : canonical
      seen.set(absolute, identity(await fs.lstat(absolute, { bigint: true })))
      for (const name of (await fs.readdir(absolute)).sort()) {
        signal?.throwIfAborted()
        const relative = directory ? `${directory}/${name}` : name
        const file = filename(canonical, relative)
        const before = await fs.lstat(file, { bigint: true })
        seen.set(file, identity(before))
        const mode = Number(before.mode & 0o777n)
        if (before.isDirectory()) {
          entries.push({ path: relative, kind: "directory", mode })
          directories.push(relative)
        } else if (before.isSymbolicLink())
          entries.push({ path: relative, kind: "symlink", mode, target: await fs.readlink(file) })
        else if (before.isFile()) {
          if ((await fs.realpath(file)) !== file) throw new Error("Workspace changed during checkpoint")
          const handle = await fs.open(
            file,
            constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
          )
          try {
            if (identity(await handle.stat({ bigint: true })) !== identity(before))
              throw new Error("Workspace changed during checkpoint")
            const chunks: Array<{ hash: string; size: number }> = []
            const digest = createHash("sha256")
            const buffer = Buffer.allocUnsafe(WorkspaceTree.chunkBytes)
            let size = 0
            for (;;) {
              signal?.throwIfAborted()
              let length = 0
              while (length < buffer.length) {
                const read = await handle.read(buffer, length, buffer.length - length, null)
                if (!read.bytesRead) break
                length += read.bytesRead
              }
              if (!length) break
              const bytes = buffer.subarray(0, length)
              const hash = WorkspaceTree.hash(bytes)
              digest.update(bytes)
              await store.put(hash, bytes)
              chunks.push({ hash, size: length })
              size += length
            }
            if (identity(await handle.stat({ bigint: true })) !== identity(before))
              throw new Error("Workspace changed during checkpoint")
            entries.push({ path: relative, kind: "file", mode, size, hash: digest.digest("hex"), chunks })
          } finally {
            await handle.close()
          }
        } else throw new Error(`Workspace checkpoint cannot preserve special file: ${relative}`)
        if (entries.length > 100_000) throw new Error("Workspace manifest exceeds its entry limit")
      }
    }
    for (const [file, version] of seen) {
      signal?.throwIfAborted()
      if (identity(await fs.lstat(file, { bigint: true })) !== version)
        throw new Error("Workspace changed during checkpoint")
    }
    return WorkspaceTree.Manifest.parse({ version: 1, entries })
  }

  export async function materialize(
    root: string,
    raw: WorkspaceTree.Manifest,
    store: BlobStore,
    options: { signal?: AbortSignal; owner?: { uid: number; gid: number } } = {},
  ) {
    const tree = WorkspaceTree.Manifest.parse(raw)
    const destination = path.resolve(root)
    const parent = await fs.realpath(path.dirname(destination))
    if (parent !== path.dirname(destination)) throw new Error("Workspace destination must have a canonical parent")
    const previous = await fs.lstat(destination, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
    if (previous && (!previous.isDirectory() || (await fs.readdir(destination)).length))
      throw new Error("Workspace destination must be empty")
    const temporary = await fs.mkdtemp(path.join(parent, ".synergy-materialize-"))
    let published = false
    try {
      const directories = tree.entries
        .filter((entry) => entry.kind === "directory")
        .sort((a, b) => a.path.split("/").length - b.path.split("/").length)
      for (const entry of directories) await fs.mkdir(filename(temporary, entry.path), { mode: 0o700 })
      for (const entry of tree.entries) {
        options.signal?.throwIfAborted()
        const target = filename(temporary, entry.path)
        if (entry.kind === "directory") continue
        if (entry.kind === "symlink") {
          await fs.symlink(entry.target, target)
          if (options.owner) await fs.lchown(target, options.owner.uid, options.owner.gid)
          continue
        }
        const handle = await fs.open(target, "wx", 0o600)
        try {
          const hash = createHash("sha256")
          for (const chunk of entry.chunks) {
            options.signal?.throwIfAborted()
            const bytes = WorkspaceTree.verify(chunk.hash, await store.get(chunk.hash, chunk.size), chunk.size)
            if (bytes.length !== chunk.size) throw new Error("Workspace chunk integrity check failed")
            hash.update(bytes)
            await handle.writeFile(bytes)
          }
          if (hash.digest("hex") !== entry.hash) throw new Error("Workspace file integrity check failed")
          if (options.owner) await handle.chown(options.owner.uid, options.owner.gid)
          await handle.chmod(entry.mode)
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
      for (const entry of directories.reverse()) {
        const target = filename(temporary, entry.path)
        if (options.owner) await fs.chown(target, options.owner.uid, options.owner.gid)
        await fs.chmod(target, entry.mode)
        await flushDirectory(target)
      }
      if (options.owner) await fs.chown(temporary, options.owner.uid, options.owner.gid)
      await fs.chmod(temporary, 0o755)
      await flushDirectory(temporary)
      options.signal?.throwIfAborted()
      const current = await fs.lstat(destination, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      })
      if ((current ? identity(current) : null) !== (previous ? identity(previous) : null))
        throw new Error("Workspace destination changed during materialization")
      if (current) await fs.rmdir(destination)
      await fs.rename(temporary, destination)
      published = true
      await flushDirectory(parent)
    } finally {
      if (!published) await fs.rm(temporary, { recursive: true, force: true })
    }
  }
}
