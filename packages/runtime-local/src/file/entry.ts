import fs from "node:fs/promises"
import { constants, type BigIntStats } from "node:fs"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { WorkspaceAccess } from "@ericsanchezok/synergy-harness/workspace/access"
import { isPathContained } from "@ericsanchezok/synergy-harness/util/path-contain"
import { withFileLock } from "@ericsanchezok/synergy-util/fs-lock"
import { FileMutation } from "./mutation"
import { FileRename } from "./rename"

export namespace FileEntry {
  export class PartialError extends Error {
    override name = "WorkspaceFilePartialMutationError"
    constructor(
      message: string,
      readonly completed: string[],
      options?: ErrorOptions,
    ) {
      super(message, options)
    }
  }
  export class LimitError extends Error {
    override name = "WorkspaceFileTooLargeError"
  }
  export type Validation = (target: string, operation: "read" | "write") => Promise<void>
  interface Options {
    signal?: AbortSignal
    validate?: Validation
    checkpoint?: () => Promise<void>
  }
  export interface Entry {
    version: string
    type: "file" | "directory" | "symlink" | "unknown"
    stat: BigIntStats
    link?: string
  }
  function version(stat: BigIntStats, link?: string) {
    const values = [stat.dev, stat.ino, stat.mode, stat.size, stat.birthtimeNs, stat.ctimeNs, stat.mtimeNs].map(String)
    return `entry:${createHash("sha256")
      .update(JSON.stringify([values, link]))
      .digest("hex")}`
  }
  export async function canonical(input: string) {
    const absolute = path.resolve(input)
    return path.join(await FileMutation.canonical(path.dirname(absolute)), path.basename(absolute))
  }
  export async function inspect(input: string): Promise<Entry | null> {
    const stat = await fs.lstat(input, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
      return undefined
    })
    if (!stat) return null
    const type = stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "directory"
        : stat.isFile()
          ? "file"
          : "unknown"
    const link = type === "symlink" ? await fs.readlink(input) : undefined
    if (link !== undefined && version(await fs.lstat(input, { bigint: true }), link) !== version(stat, link))
      throw new FileMutation.ConflictError()
    return { version: version(stat, link), type, stat, link }
  }
  async function requireVersion(target: string, expectedVersion: string) {
    const current = await inspect(target)
    if (!current || current.version !== expectedVersion) throw new FileMutation.ConflictError()
    if (current.type === "unknown")
      throw new FileMutation.AccessDeniedError("Special filesystem entries cannot be modified")
    return current
  }
  async function paths<T>(
    inputs: string[],
    options: Options,
    fn: (targets: string[], checkpoint: () => Promise<void>) => Promise<T>,
  ) {
    options.signal?.throwIfAborted()
    const targets = await Promise.all(inputs.map(canonical))
    return WorkspaceAccess.write(
      targets.map((target) => path.dirname(target)),
      async () => {
        const directory = await FileMutation.lockDirectory()
        const keys = [...new Set(targets)].sort()
        const lock = async (index: number): Promise<T> => {
          if (index < keys.length)
            return withFileLock({ directory, key: keys[index]!, signal: options.signal }, () => lock(index + 1))
          options.signal?.throwIfAborted()
          const parents = new Map<string, { dev: bigint; ino: bigint }>()
          for (const target of targets) {
            let parent = path.dirname(target)
            while (!(await inspect(parent))) parent = path.dirname(parent)
            const stat = await fs.stat(parent, { bigint: true })
            parents.set(parent, { dev: stat.dev, ino: stat.ino })
          }
          const checkpoint = async () => {
            options.signal?.throwIfAborted()
            WorkspaceAccess.signal()?.throwIfAborted()
            for (let index = 0; index < inputs.length; index++) {
              if ((await canonical(inputs[index]!)) !== targets[index]) throw new FileMutation.ConflictError()
            }
            for (const [parent, expected] of parents) {
              const stat = await fs.stat(parent, { bigint: true })
              if (stat.dev !== expected.dev || stat.ino !== expected.ino) throw new FileMutation.ConflictError()
            }
          }
          await checkpoint()
          return fn(targets, checkpoint)
        }
        return lock(0)
      },
      options.signal,
    )
  }
  async function syncParent(target: string) {
    if (process.platform === "win32") return
    const directory = await fs.open(path.dirname(target), constants.O_RDONLY)
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  }
  interface Member {
    relative: string
    entry: Entry
  }
  async function tree(root: string, options: Options): Promise<Member[]> {
    const result: Member[] = []
    const visit = async (relative: string, depth: number) => {
      options.signal?.throwIfAborted()
      if (depth > 256 || result.length >= 100_000)
        throw new LimitError("File operation exceeds 100,000 entries or 256 directory levels")
      const target = path.join(root, relative)
      const entry = await inspect(target)
      if (!entry) throw new FileMutation.ConflictError()
      if (entry.type === "unknown")
        throw new FileMutation.AccessDeniedError("Special filesystem entries cannot be copied or removed")
      result.push({ relative, entry })
      if (entry.type === "directory") {
        const names: string[] = []
        const directory = await fs.opendir(target)
        for await (const item of directory) {
          if (names.length + result.length >= 100_000) throw new LimitError("File operation exceeds 100,000 entries")
          options.signal?.throwIfAborted()
          names.push(item.name)
        }
        for (const name of names.sort()) await visit(path.join(relative, name), depth + 1)
      }
      await requireVersion(target, entry.version)
    }
    await visit("", 0)
    return result
  }
  async function verifyTree(root: string, members: Member[], options: Options) {
    const current = await tree(root, options)
    if (
      current.length !== members.length ||
      current.some(
        (member, index) =>
          member.relative !== members[index]!.relative || member.entry.version !== members[index]!.entry.version,
      )
    )
      throw new FileMutation.ConflictError()
  }
  async function validateTree(root: string, members: Member[], options: Options, operation: "read" | "write") {
    for (const member of members) {
      options.signal?.throwIfAborted()
      await options.validate?.(path.join(root, member.relative), operation)
    }
  }
  export async function mkdir(input: { path: string; createParents?: boolean } & Options) {
    return paths([input.path], input, async ([target], checkpoint) => {
      await input.validate?.(target!, "write")
      if (await inspect(target!)) throw new FileMutation.ConflictError()
      if (input.createParents) await fs.mkdir(path.dirname(target!), { recursive: true })
      if ((await canonical(input.path)) !== target) throw new FileMutation.ConflictError()
      await input.validate?.(target!, "write")
      input.signal?.throwIfAborted()
      await checkpoint()
      await fs.mkdir(target!)
      try {
        await syncParent(target!)
      } catch (cause) {
        throw new PartialError("Directory created, but durability confirmation failed", [target!], { cause })
      }
      return (await inspect(target!))!
    })
  }
  export async function replace(
    input: {
      path: string
      expectedVersion: string | null
      content: Uint8Array
      mode: "100644" | "100755" | "120000"
      createParents?: boolean
    } & Options,
  ) {
    return paths([input.path], input, async ([target], checkpoint) => {
      const absolute = target!
      const before = await inspect(absolute)
      if ((before?.version ?? null) !== input.expectedVersion) throw new FileMutation.ConflictError()
      if (before && before.type !== "file" && before.type !== "symlink")
        throw new FileMutation.AccessDeniedError("A directory or special file cannot be replaced by a file snapshot")
      if (before?.type === "file" && (before.stat.mode & 0o222n) === 0n)
        throw new FileMutation.AccessDeniedError("Access denied: file is read-only")
      await input.validate?.(absolute, "write")
      if (input.createParents) await fs.mkdir(path.dirname(absolute), { recursive: true })
      const temporary = path.join(path.dirname(absolute), `.synergy-restore-${randomUUID()}`)
      let published = false
      try {
        if (input.mode === "120000") {
          const link = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input.content)
          if (!link || link.includes("\0")) throw new FileMutation.AccessDeniedError("Invalid snapshot symlink")
          await fs.symlink(link, temporary)
        } else {
          const mode = input.mode === "100755" ? 0o755 : 0o644
          const file = await fs.open(temporary, "wx", mode)
          try {
            await file.writeFile(input.content)
            await file.chmod(mode & ~process.umask())
            await file.sync()
          } finally {
            await file.close()
          }
        }
        await checkpoint()
        await input.validate?.(absolute, "write")
        if ((await inspect(absolute))?.version !== before?.version) throw new FileMutation.ConflictError()
        if (before) await fs.rename(temporary, absolute)
        else FileRename.exclusive(temporary, absolute)
        published = true
        await syncParent(absolute)
      } catch (cause) {
        if (published)
          throw new PartialError("File restored, but durability confirmation failed", [absolute], { cause })
        throw cause
      } finally {
        await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error
        })
      }
    })
  }

  interface Transfer extends Options {
    from: string
    to: string
    expectedVersion: string
  }
  function separated(from: string, to: string) {
    if (from !== to && path.dirname(from) === path.dirname(to)) return
    if (
      isPathContained(from, to, { followFinalSymlink: false }) ||
      isPathContained(to, from, { followFinalSymlink: false })
    )
      throw new FileMutation.AccessDeniedError("Source and destination must be separate filesystem entries")
  }
  async function copyFile(from: string, to: string, entry: Entry, signal?: AbortSignal) {
    const source = await fs.open(
      from,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
    )
    try {
      if (version(await source.stat({ bigint: true })) !== entry.version) throw new FileMutation.ConflictError()
      const destination = await fs.open(to, "wx", 0o600)
      try {
        const buffer = Buffer.allocUnsafe(128 * 1024)
        let offset = 0
        while (offset < entry.stat.size) {
          signal?.throwIfAborted()
          const size = Number(
            entry.stat.size - BigInt(offset) > BigInt(buffer.length) ? buffer.length : entry.stat.size - BigInt(offset),
          )
          const { bytesRead } = await source.read(buffer, 0, size, offset)
          if (!bytesRead) throw new FileMutation.ConflictError()
          await destination.writeFile(buffer.subarray(0, bytesRead))
          offset += bytesRead
        }
        if (version(await source.stat({ bigint: true })) !== entry.version) throw new FileMutation.ConflictError()
        await destination.chmod(Number(entry.stat.mode & 0o777n))
        await destination.utimes(Number(entry.stat.atimeNs) / 1e9, Number(entry.stat.mtimeNs) / 1e9)
        await destination.sync()
      } finally {
        await destination.close()
      }
    } finally {
      await source.close()
    }
  }
  async function copyTree(from: string, to: string, members: Member[], input: Transfer) {
    await validateTree(from, members, input, "read")
    await validateTree(to, members, input, "write")
    if (await inspect(to)) throw new FileMutation.ConflictError()
    const staging = await fs.mkdtemp(path.join(path.dirname(to), ".synergy-copy-"))
    await fs.chmod(staging, 0o700)
    const output = path.join(staging, "entry")
    let published = false
    try {
      for (const member of members) {
        input.signal?.throwIfAborted()
        const source = path.join(from, member.relative),
          target = path.join(output, member.relative)
        await requireVersion(source, member.entry.version)
        if (member.entry.type === "directory") await fs.mkdir(target, { mode: 0o700 })
        else if (member.entry.type === "symlink") await fs.symlink(member.entry.link!, target)
        else await copyFile(source, target, member.entry, input.signal)
      }
      for (const member of [...members].reverse())
        if (member.entry.type === "directory") {
          const target = path.join(output, member.relative)
          await fs.chmod(target, Number(member.entry.stat.mode & 0o777n))
          await fs.utimes(target, Number(member.entry.stat.atimeNs) / 1e9, Number(member.entry.stat.mtimeNs) / 1e9)
          if (process.platform !== "win32") {
            const handle = await fs.open(target, constants.O_RDONLY)
            try {
              await handle.sync()
            } finally {
              await handle.close()
            }
          }
        }
      await verifyTree(from, members, input)
      if ((await canonical(input.from)) !== from || (await canonical(input.to)) !== to)
        throw new FileMutation.ConflictError()
      await validateTree(to, members, input, "write")
      input.signal?.throwIfAborted()
      await input.checkpoint?.()
      FileRename.exclusive(output, to)
      published = true
      await syncParent(to)
    } catch (cause) {
      if (published) throw new PartialError("Copy published, but durability confirmation failed", [to], { cause })
      throw cause
    } finally {
      for (const member of members) {
        if (member.entry.type !== "directory") continue
        const target = path.join(output, member.relative)
        const copied = await inspect(target)
        if (copied?.type === "directory") await fs.chmod(target, Number(copied.stat.mode & 0o777n) | 0o700)
      }
      await fs.rm(staging, { recursive: true, force: true })
    }
  }
  export async function copy(input: Transfer) {
    return paths([input.from, input.to], input, async ([from, to], checkpoint) => {
      separated(from!, to!)
      await requireVersion(from!, input.expectedVersion)
      const members = await tree(from!, input)
      if (members[0]!.entry.version !== input.expectedVersion) throw new FileMutation.ConflictError()
      await copyTree(from!, to!, members, { ...input, checkpoint })
      return (await inspect(to!))!
    })
  }
  export async function move(input: Transfer) {
    return paths([input.from, input.to], input, async ([from, to], checkpoint) => {
      separated(from!, to!)
      await requireVersion(from!, input.expectedVersion)
      const members = await tree(from!, input)
      await validateTree(from!, members, input, "write")
      await validateTree(to!, members, input, "write")
      await verifyTree(from!, members, input)
      input.signal?.throwIfAborted()
      if (members[0]!.entry.version !== input.expectedVersion) throw new FileMutation.ConflictError()
      await checkpoint()
      try {
        FileRename.exclusive(from!, to!)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
        await copyTree(from!, to!, members, { ...input, checkpoint })
        try {
          await removeTree(from!, members, { ...input, checkpoint })
        } catch (cause) {
          throw new PartialError(
            "Destination copied, but the source could not be fully removed",
            [to!, ...(cause instanceof PartialError ? cause.completed : [])],
            { cause },
          )
        }
      }
      try {
        await Promise.all([syncParent(from!), syncParent(to!)])
      } catch (cause) {
        throw new PartialError("Entry moved, but durability confirmation failed", [to!], { cause })
      }
      return (await inspect(to!))!
    })
  }
  async function removeTree(target: string, members: Member[], input: Options) {
    await validateTree(target, members, input, "write")
    await verifyTree(target, members, input)
    const completed: string[] = []
    try {
      for (const member of [...members].reverse()) {
        input.signal?.throwIfAborted()
        await input.checkpoint?.()
        const absolute = path.join(target, member.relative)
        if (member.entry.type === "directory") {
          const current = await inspect(absolute)
          if (
            !current ||
            current.type !== "directory" ||
            current.stat.dev !== member.entry.stat.dev ||
            current.stat.ino !== member.entry.stat.ino
          )
            throw new FileMutation.ConflictError()
          await fs.rmdir(absolute)
        } else {
          await requireVersion(absolute, member.entry.version)
          await fs.unlink(absolute)
        }
        completed.push(absolute)
      }
    } catch (cause) {
      if (completed.length)
        throw new PartialError("Some entries were removed; remaining entries were preserved", completed, { cause })
      throw cause
    }
  }
  export async function remove(input: { path: string; expectedVersion: string; recursive?: boolean } & Options) {
    return paths([input.path], input, async ([target], checkpoint) => {
      const entry = await requireVersion(target!, input.expectedVersion)
      const members = await tree(target!, input)
      if (!input.recursive && entry.type === "directory" && members.length > 1)
        throw new FileMutation.AccessDeniedError("Directory is not empty; recursive removal is required")
      if (members[0]!.entry.version !== input.expectedVersion) throw new FileMutation.ConflictError()
      await removeTree(target!, members, { ...input, checkpoint })
      try {
        await syncParent(target!)
      } catch (cause) {
        throw new PartialError(
          "Entries removed, but durability confirmation failed",
          members.map((member) => path.join(target!, member.relative)),
          { cause },
        )
      }
    })
  }
}
