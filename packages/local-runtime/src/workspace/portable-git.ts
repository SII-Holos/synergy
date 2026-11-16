import fs from "node:fs/promises"
import { constants, type BigIntStats } from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"
import { z } from "zod"
import { NamedError } from "@ericsanchezok/synergy-util/error"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import { initializeSqliteEngine } from "@ericsanchezok/synergy-harness/storage/sqlite-engine"
import { SnapshotGit } from "@ericsanchezok/synergy-harness/session/snapshot-git"
import { SnapshotStore } from "@ericsanchezok/synergy-harness/session/snapshot-store"

export namespace NativePortableGit {
  export const Unsupported = NamedError.create(
    "NativePortableGitUnsupported",
    z.object({
      message: z.string(),
      missing: z.object({
        kind: z.enum([
          "git_binding",
          "git_metadata",
          "git_metadata_link",
          "git_capture_directory",
          "git_in_progress",
          "git_shallow",
          "git_grafts",
          "git_lfs",
          "git_config_include",
          "git_filter",
          "git_submodule",
          "git_extension",
          "git_sparse_checkout",
          "git_config_dependency",
          "git_split_index",
          "git_bare",
          "git_root",
          "git_object_format",
          "git_refs",
          "git_partial_clone",
          "git_alternates",
          "git_nested_repository",
        ]),
      }),
    }),
  )
  export const Changed = NamedError.create("NativePortableGitChanged", z.object({ message: z.string() }))
  export const Busy = NamedError.create("NativePortableGitBusy", z.object({ message: z.string() }))
  export interface Discovery {
    readonly root: string
    readonly gitDirectory: string
    readonly commonDirectory: string
    readonly dependencies: readonly string[]
  }
  export interface Prepared extends AsyncDisposable {
    readonly gitDirectory: string
    verify(): Promise<void>
  }
  const discoveries = new WeakMap<
    Discovery,
    { runtime: RuntimeContext.Instance; selected: string; fingerprint: string }
  >()
  const oid = /^[a-f0-9]{40}$/
  function fail(kind: z.infer<typeof Unsupported.Schema>["data"]["missing"]["kind"]): never {
    throw new Unsupported({ message: "Git Workspace requires an unsupported portable dependency", missing: { kind } })
  }
  const changed = (): never => {
    throw new Changed({ message: "Git Workspace changed during capture" })
  }
  const identity = (stat: BigIntStats) =>
    [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(":")
  const optional = (name: string) =>
    fs.lstat(name, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
  const inside = (root: string, target: string) => {
    const relative = path.relative(root, target)
    return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
  }
  async function* content(filename: string, signal?: AbortSignal, expected?: BigIntStats) {
    signal?.throwIfAborted()
    const before = await fs.lstat(filename, { bigint: true })
    if (!before.isFile()) fail("git_metadata_link")
    if (expected && identity(expected) !== identity(before)) changed()
    const file = await fs.open(
      filename,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
    )
    try {
      if (identity(await file.stat({ bigint: true })) !== identity(before)) changed()
      const buffer = new Uint8Array(65_536)
      for (;;) {
        signal?.throwIfAborted()
        const result = await file.read(buffer, 0, buffer.length, null)
        if (!result.bytesRead) break
        yield buffer.subarray(0, result.bytesRead)
      }
      if (
        identity(before) !== identity(await file.stat({ bigint: true })) ||
        identity(before) !== identity(await fs.lstat(filename, { bigint: true }))
      )
        changed()
    } finally {
      await file.close()
    }
  }
  async function text(filename: string, signal?: AbortSignal) {
    const stat = await optional(filename)
    if (!stat) return
    if (!stat.isFile() || stat.size > 65_536n) fail("git_metadata")
    if ((await fs.realpath(filename)) !== filename) fail("git_metadata_link")
    let result = ""
    for await (const chunk of content(filename, signal, stat)) {
      result += Buffer.from(chunk).toString("utf8")
      if (Buffer.byteLength(result) > 65_536) fail("git_metadata")
    }
    return result
  }
  async function write(file: Awaited<ReturnType<typeof fs.open>>, value: Uint8Array | string) {
    const bytes = typeof value === "string" ? Buffer.from(value) : value
    for (let offset = 0; offset < bytes.byteLength;) {
      const result = await file.write(bytes, offset, bytes.byteLength - offset)
      if (!result.bytesWritten) fail("git_metadata")
      offset += result.bytesWritten
    }
  }
  async function temporary(source: Discovery, requested: string) {
    let parent = path.resolve(requested)
    const suffix: string[] = []
    while (!(await optional(parent))) {
      suffix.unshift(path.basename(parent))
      const next = path.dirname(parent)
      if (next === parent) fail("git_capture_directory")
      parent = next
    }
    parent = path.join(await fs.realpath(parent), ...suffix)
    if ([source.root, source.gitDirectory, source.commonDirectory].some((root) => inside(root, parent)))
      fail("git_capture_directory")
    await fs.mkdir(parent, { recursive: true, mode: 0o700 })
    parent = await fs.realpath(parent)
    if ([source.root, source.gitDirectory, source.commonDirectory].some((root) => inside(root, parent)))
      fail("git_capture_directory")
    return fs.mkdtemp(path.join(parent, "portable-git-"))
  }
  async function* git(repo: string, args: string[], separator = "\n", signal?: AbortSignal, inputFile?: string) {
    const abort = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)])
      : AbortSignal.timeout(30 * 60_000)
    abort.throwIfAborted()
    const input = inputFile ? await fs.open(inputFile, "r") : undefined
    let proc: Bun.Subprocess<number | "ignore", "pipe", "ignore">
    try {
      proc = Bun.spawn(
        [
          "git",
          "-c",
          "core.longpaths=true",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.attributesFile=/dev/null",
          "--git-dir",
          repo,
          ...args,
        ],
        {
          cwd: path.dirname(repo),
          env: SnapshotGit.environment({
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_OPTIONAL_LOCKS: "0",
            GIT_PAGER: "cat",
          }),
          stdin: input?.fd ?? "ignore",
          stdout: "pipe",
          stderr: "ignore",
          signal: abort,
        },
      )
    } catch (error) {
      await input?.close()
      throw error
    }
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder("utf8", { fatal: true })
    let pending = ""
    try {
      for (;;) {
        abort.throwIfAborted()
        const chunk = await reader.read()
        abort.throwIfAborted()
        if (chunk.done) break
        pending += decoder.decode(chunk.value, { stream: true })
        let index: number
        while ((index = pending.indexOf(separator)) !== -1) {
          yield pending.slice(0, index)
          pending = pending.slice(index + separator.length)
        }
        if (pending.length > 1024 * 1024) fail("git_metadata")
      }
      pending += decoder.decode()
      if (pending) yield pending
      const code = await proc.exited
      abort.throwIfAborted()
      if (code) fail("git_metadata")
    } catch (error) {
      if (abort.aborted) throw abort.reason
      throw error
    } finally {
      reader.releaseLock()
      if (proc.exitCode === null) proc.kill()
      await proc.exited
      await input?.close()
    }
  }
  async function* walk(db: Database, root: string, signal?: AbortSignal, workingFiles = false) {
    const scan = crypto.randomUUID()
    using insert = db.prepare("INSERT INTO frontier VALUES(?,?,0)")
    using next = db.prepare<{ path: string }, [string]>(
      "SELECT path FROM frontier WHERE scan=? AND visited=0 ORDER BY path LIMIT 1",
    )
    using visit = db.prepare("UPDATE frontier SET visited=1 WHERE scan=? AND path=?")
    insert.run(scan, "")
    try {
      for (;;) {
        signal?.throwIfAborted()
        const row = next.get(scan)
        if (!row) break
        visit.run(scan, row.path)
        const directory = path.join(root, row.path)
        const directoryStat = await fs.lstat(directory)
        if (
          !directoryStat.isDirectory() ||
          directoryStat.isSymbolicLink() ||
          (await fs.realpath(directory)) !== directory
        )
          fail("git_metadata_link")
        for await (const entry of await fs.opendir(directory)) {
          signal?.throwIfAborted()
          if (workingFiles && !row.path && entry.name === ".git") continue
          const relative = row.path ? row.path + "/" + entry.name : entry.name
          const filename = path.join(root, ...relative.split("/"))
          const stat = await fs.lstat(filename, { bigint: true })
          if (!workingFiles && (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())))
            fail("git_metadata_link")
          if (workingFiles && entry.name === ".git") fail("git_nested_repository")
          if (stat.isDirectory()) insert.run(scan, relative)
          else yield { relative, filename, stat }
        }
      }
    } finally {
      db.prepare("DELETE FROM frontier WHERE scan=?").run(scan)
    }
  }
  // Provenance: https://git-scm.com/docs/gitrepository-layout (commondir and per-worktree refs, HEAD and index).
  // Local adaptation: private views retain selected data while omitting executable configuration and operational logs.
  async function snapshot(source: Discovery, requested: string, signal?: AbortSignal) {
    await initializeSqliteEngine()
    const directory = await temporary(source, requested)
    const db = new Database(path.join(directory, "inventory.sqlite"))
    db.exec(
      "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE frontier(scan TEXT,path TEXT,visited INTEGER,PRIMARY KEY(scan,path)); CREATE TABLE metadata(path TEXT PRIMARY KEY,digest TEXT)",
    )
    let returned = false
    try {
      const common = path.join(directory, "common.git")
      const view = source.gitDirectory === source.commonDirectory ? common : path.join(directory, "selected.git")
      await SnapshotStore.initializeBareRepository(common, "transient", { emptyTemplate: true })
      const objects = path.join(source.commonDirectory, "objects")
      const objectStat = await fs.lstat(objects)
      if (!objectStat.isDirectory() || objectStat.isSymbolicLink()) fail("git_metadata_link")
      if (view !== common) {
        await fs.mkdir(view)
        await fs.writeFile(path.join(view, "commondir"), common + "\n", { mode: 0o600 })
      }
      using insert = db.prepare("INSERT INTO metadata VALUES(?,?)")
      for (const [label, location] of [
        ["root", source.root],
        ["git", source.gitDirectory],
        ["common", source.commonDirectory],
      ] as const) {
        if ((await fs.realpath(location)) !== location) changed()
        const stat = await fs.lstat(location, { bigint: true })
        if (!stat.isDirectory() || stat.isSymbolicLink()) changed()
        insert.run("location/" + label, [stat.dev, stat.ino, stat.mode].join(":"))
      }
      async function copy(from: string, to: string | undefined, key: string) {
        const stat = await optional(from)
        if (!stat) {
          insert.run(key, "missing")
          return
        }
        if ((await fs.realpath(from)) !== from) fail("git_metadata_link")
        const hash = createHash("sha256")
        if (to) await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 })
        const output = to ? await fs.open(to, "w", 0o600) : undefined
        try {
          for await (const bytes of content(from, signal, stat)) {
            hash.update(bytes)
            if (output) await write(output, bytes)
          }
          if (output) await output.sync()
        } finally {
          await output?.close()
        }
        insert.run(key, identity(stat) + ":" + hash.digest("hex"))
      }
      async function refs(from: string, to: string, prefix: string) {
        const stat = await optional(from)
        if (!stat) return
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail("git_metadata_link")
        for await (const entry of walk(db, from, signal))
          await copy(entry.filename, path.join(to, ...entry.relative.split("/")), prefix + "/" + entry.relative)
      }
      const settings = new Map<string, string>()
      const allowed: Record<string, readonly string[]> = {
        "core.filemode": ["true", "false"],
        "core.ignorecase": ["true", "false"],
        "core.symlinks": ["true", "false"],
        "core.autocrlf": ["true", "false", "input"],
        "core.eol": ["lf", "crlf", "native"],
        "core.safecrlf": ["true", "false", "warn"],
        "core.trustctime": ["true", "false"],
        "core.checkstat": ["default", "minimal"],
      }
      for (const [label, root] of [
        ["common", source.commonDirectory],
        ["selected", source.gitDirectory],
      ] as const) {
        const info = await optional(path.join(root, "info"))
        if (info && (!info.isDirectory() || info.isSymbolicLink())) fail("git_metadata_link")
        for (const marker of [
          "MERGE_HEAD",
          "CHERRY_PICK_HEAD",
          "REVERT_HEAD",
          "REBASE_HEAD",
          "rebase-merge",
          "rebase-apply",
          "sequencer",
          "BISECT_LOG",
          "BISECT_START",
          "index.lock",
          "packed-refs.lock",
        ])
          if (await optional(path.join(root, marker))) fail("git_in_progress")
        if (await optional(path.join(root, "shallow"))) fail("git_shallow")
        if (await optional(path.join(root, "info", "grafts"))) fail("git_grafts")
        if (await optional(path.join(root, "lfs"))) fail("git_lfs")
        for (const name of ["config", "config.worktree"]) {
          const original = path.join(root, name)
          const captured = path.join(directory, label + "-" + name)
          await copy(original, captured, label + "/" + name)
          if (!(await optional(captured))) continue
          for await (const key of git(
            common,
            ["config", "--file", captured, "--no-includes", "--name-only", "--list", "-z"],
            "\0",
            signal,
          )) {
            const lower = key.toLowerCase()
            if (Object.hasOwn(allowed, lower)) {
              for await (const setting of git(
                common,
                ["config", "--file", captured, "--no-includes", "--get", key],
                "\n",
                signal,
              )) {
                if (!allowed[lower]!.includes(setting.toLowerCase())) fail("git_config_dependency")
                settings.set(lower.slice(5), setting.toLowerCase())
              }
            }
            if (lower.startsWith("include")) fail("git_config_include")
            if (lower.startsWith("lfs.") || lower.startsWith("filter.lfs.")) fail("git_lfs")
            if (lower.startsWith("filter.")) fail("git_filter")
            if (lower.startsWith("submodule.")) fail("git_submodule")
            if (lower.startsWith("extensions.") && lower !== "extensions.worktreeconfig") fail("git_extension")
            if (["core.sparsecheckout", "core.sparsecheckoutcone", "index.sparse"].includes(lower))
              fail("git_sparse_checkout")
            if (["core.attributesfile", "core.worktree"].includes(lower)) fail("git_config_dependency")
          }
        }
        for await (const file of await fs.opendir(root))
          if (file.name.startsWith("sharedindex.")) fail("git_split_index")
      }
      const objectInfo = await optional(path.join(objects, "info"))
      if (objectInfo && (!objectInfo.isDirectory() || objectInfo.isSymbolicLink())) fail("git_metadata_link")
      for (const file of ["alternates", "http-alternates"])
        if (await optional(path.join(objects, "info", file))) fail("git_alternates")
      for await (const entry of walk(db, objects, signal))
        if (entry.relative.endsWith(".promisor")) fail("git_partial_clone")
      await refs(path.join(source.commonDirectory, "refs"), path.join(common, "refs"), "common/refs")
      await copy(
        path.join(source.commonDirectory, "packed-refs"),
        path.join(common, "packed-refs"),
        "common/packed-refs",
      )
      if (view !== common) await refs(path.join(source.gitDirectory, "refs"), path.join(view, "refs"), "selected/refs")
      await copy(path.join(source.gitDirectory, "HEAD"), path.join(view, "HEAD"), "HEAD")
      await copy(path.join(source.gitDirectory, "index"), path.join(view, "index"), "index")
      await copy(path.join(source.gitDirectory, "ORIG_HEAD"), path.join(view, "ORIG_HEAD"), "ORIG_HEAD")
      await copy(
        path.join(source.commonDirectory, "info", "exclude"),
        path.join(common, "info", "exclude"),
        "info/exclude",
      )
      await copy(
        path.join(source.commonDirectory, "info", "attributes"),
        path.join(common, "info", "attributes"),
        "info/attributes",
      )
      await copy(path.join(source.gitDirectory, "commondir"), undefined, "commondir")
      await copy(path.join(source.gitDirectory, "gitdir"), undefined, "gitdir")
      const attributes = path.join(directory, "attributes")
      await fs.mkdir(attributes)
      for await (const entry of walk(db, source.root, signal, true)) {
        const name = path.basename(entry.relative)
        if (name === ".git") fail("git_nested_repository")
        if (name === ".gitmodules") fail("git_submodule")
        if (name === ".lfsconfig") fail("git_lfs")
        if (name !== ".gitattributes") continue
        if (!entry.stat.isFile()) fail("git_metadata_link")
        await copy(entry.filename, path.join(attributes, ...entry.relative.split("/")), "work/" + entry.relative)
      }
      const pointer = path.join(source.root, ".git")
      const stat = await fs.lstat(pointer, { bigint: true })
      if (stat.isFile()) await copy(pointer, undefined, "pointer")
      else if (stat.isDirectory()) insert.run("pointer", [stat.dev, stat.ino].join(":"))
      else fail("git_binding")
      const hash = createHash("sha256")
      using rows = db.prepare<{ path: string; digest: string }, [string]>(
        "SELECT path,digest FROM metadata WHERE path>? ORDER BY path LIMIT 128",
      )
      let after = ""
      for (;;) {
        const page = rows.all(after)
        for (const row of page) hash.update(JSON.stringify([row.path, row.digest]) + "\n")
        if (page.length < 128) break
        after = page.at(-1)!.path
      }
      returned = true
      return {
        directory,
        view,
        attributes,
        settings,
        fingerprint: hash.digest("hex"),
        async [Symbol.asyncDispose]() {
          await fs.rm(directory, { recursive: true, force: true })
        },
      }
    } finally {
      db.close(true)
      if (!returned) await fs.rm(directory, { recursive: true, force: true })
    }
  }
  export async function discover(input: { directory: string; signal?: AbortSignal }): Promise<Discovery | undefined> {
    const selected = path.resolve(input.directory)
    const signal = input.signal
    const runtime = RuntimeContext.current()
    signal?.throwIfAborted()
    let root = await fs.realpath(selected)
    if (!(await fs.lstat(root)).isDirectory()) fail("git_binding")
    for (;;) {
      const pointer = path.join(root, ".git")
      const stat = await optional(pointer)
      if (stat) {
        if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) fail("git_binding")
        const raw = stat.isFile() ? (await text(pointer, signal))!.trim() : undefined
        if (raw !== undefined && (!raw.startsWith("gitdir: ") || !raw.slice(8).trim() || /[\r\n\0]/.test(raw)))
          fail("git_binding")
        const gitDirectory = await fs.realpath(raw === undefined ? pointer : path.resolve(root, raw.slice(8).trim()))
        const head = (await text(path.join(gitDirectory, "HEAD"), signal))?.trim()
        if (!head || (!oid.test(head) && !/^ref: refs\/[^\x00-\x20]+$/.test(head))) fail("git_binding")
        const common = (await text(path.join(gitDirectory, "commondir"), signal))?.trim()
        const commonDirectory = common ? await fs.realpath(path.resolve(gitDirectory, common)) : gitDirectory
        if (commonDirectory !== gitDirectory) {
          const back = (await text(path.join(gitDirectory, "gitdir"), signal))?.trim()
          if (!back || (await fs.realpath(path.resolve(gitDirectory, back))) !== pointer) fail("git_binding")
        }
        const source = Object.freeze({
          root,
          gitDirectory,
          commonDirectory,
          dependencies: Object.freeze([...new Set([root, gitDirectory, commonDirectory])]),
        })
        await using captured = await snapshot(source, Global.Path.cache, signal)
        if (RuntimeContext.current() !== runtime) fail("git_binding")
        discoveries.set(source, { runtime, selected: await fs.realpath(selected), fingerprint: captured.fingerprint })
        return source
      }
      if ((await optional(path.join(root, "HEAD"))) && (await optional(path.join(root, "objects")))) fail("git_bare")
      const parent = path.dirname(root)
      if (parent === root) return
      root = parent
    }
  }
  async function stageObjects(source: Discovery, directory: string, signal?: AbortSignal) {
    const db = new Database(path.join(directory, "object-frontier.sqlite"))
    db.exec(
      "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE frontier(scan TEXT,path TEXT,visited INTEGER,PRIMARY KEY(scan,path))",
    )
    const objects = path.join(source.commonDirectory, "objects")
    try {
      for await (const entry of walk(db, objects, signal)) {
        if (entry.relative.endsWith(".promisor")) fail("git_partial_clone")
        if (
          !/^[a-f0-9]{2}\/[a-f0-9]{38}$/i.test(entry.relative) &&
          !/^pack\/pack-[a-f0-9]{40}\.(pack|idx)$/i.test(entry.relative)
        )
          continue
        const before = await fs.lstat(entry.filename, { bigint: true })
        const target = path.join(directory, "common.git", "objects", ...entry.relative.split("/"))
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        try {
          await fs.link(entry.filename, target)
          const linked = await fs.lstat(target, { bigint: true })
          if (!linked.isFile() || linked.dev !== before.dev || linked.ino !== before.ino) changed()
        } catch (error) {
          if (!(
            error &&
            typeof error === "object" &&
            "code" in error &&
            ["EXDEV", "EPERM", "ENOTSUP", "EACCES", "EROFS", "EMLINK", "ENOSYS"].includes(String(error.code))
          ))
            throw error
          const output = await fs.open(target, "wx", 0o600)
          try {
            for await (const chunk of content(entry.filename, signal, before)) await write(output, chunk)
            await output.sync()
          } finally {
            await output.close()
          }
        }
      }
    } finally {
      db.close(true)
    }
  }
  export async function prepare(input: {
    source: Discovery
    directory: string
    signal?: AbortSignal
  }): Promise<Prepared> {
    const source = input.source
    const requested = path.resolve(input.directory)
    const signal = input.signal
    const runtime = RuntimeContext.current()
    const evidence = discoveries.get(source)
    if (!evidence || evidence.runtime !== runtime) fail("git_binding")
    if (evidence.selected !== source.root) fail("git_root")
    const fingerprint = evidence.fingerprint
    signal?.throwIfAborted()
    const captured = await snapshot(source, requested, signal)
    let active = true
    let returned = false
    let checking: Promise<void> | undefined
    let closing: Promise<void> | undefined
    function close() {
      active = false
      if (closing) return closing
      const work = (async () => {
        await Promise.allSettled([checking])
        await captured[Symbol.asyncDispose]()
      })()
      closing = work
      void work.catch(() => {
        if (closing === work) closing = undefined
      })
      return work
    }
    try {
      if (captured.fingerprint !== fingerprint) changed()
      if (await optional(path.join(source.root, ".gitmodules"))) fail("git_submodule")
      await stageObjects(source, captured.directory, signal)
      const paths = path.join(captured.directory, "paths")
      const names = await fs.open(paths, "wx", 0o600)
      try {
        for await (const row of git(captured.view, ["ls-files", "--stage", "-z"], "\0", signal)) {
          if (row.startsWith("160000 ")) fail("git_submodule")
          if (!/^\d{6} [a-f0-9]{40} 0\t/.test(row)) fail("git_in_progress")
          await write(names, row.slice(row.indexOf("\t") + 1) + "\0")
        }
      } finally {
        await names.close()
      }
      let attribute = 0
      for await (const value of git(
        captured.view,
        ["--work-tree", captured.attributes, "check-attr", "--stdin", "-z", "filter"],
        "\0",
        signal,
        paths,
      )) {
        if (attribute++ % 3 !== 2 || value === "unspecified" || value === "unset") continue
        fail(value === "lfs" ? "git_lfs" : "git_filter")
      }
      for await (const _line of git(
        captured.view,
        ["fsck", "--strict", "--full", "--no-reflogs", "--no-dangling"],
        "\n",
        signal,
      )) {
      }
      const inventory = path.join(captured.directory, "objects.txt")
      const output = await fs.open(inventory, "wx", 0o600)
      let count = 0
      try {
        for await (const object of git(
          captured.view,
          ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
          "\n",
          signal,
        )) {
          if (!oid.test(object)) fail("git_object_format")
          await write(output, object + "\n")
          count++
        }
        await output.sync()
      } finally {
        await output.close()
      }
      const destination = path.join(captured.directory, "portable.git")
      await SnapshotStore.initializeBareRepository(destination, "durable", { emptyTemplate: true })
      if (count)
        await SnapshotGit.importObjects(captured.view, destination, inventory, signal, "synergy-portable-workspace")
      for await (const row of git(
        captured.view,
        ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"],
        "\n",
        signal,
      )) {
        const [name, hash, symbolic] = row.split(" ")
        if (
          !name?.startsWith("refs/") ||
          name.split("/").some((part) => !part || part === "." || part === "..") ||
          !hash ||
          !oid.test(hash)
        )
          fail("git_refs")
        const target = path.join(destination, ...name.split("/"))
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        await fs.writeFile(target, symbolic ? `ref: ${symbolic}\n` : hash + "\n", { mode: 0o600 })
      }
      for (const name of ["HEAD", "index", "ORIG_HEAD"]) {
        const original = path.join(captured.view, name)
        if (!(await optional(original))) continue
        await fs.rm(path.join(destination, name), { force: true })
        await fs.copyFile(original, path.join(destination, name))
      }
      const exclude = path.join(path.dirname(captured.view), "common.git", "info", "exclude")
      if (await optional(exclude)) await fs.copyFile(exclude, path.join(destination, "info", "exclude"))
      const attributes = path.join(path.dirname(captured.view), "common.git", "info", "attributes")
      if (await optional(attributes)) await fs.copyFile(attributes, path.join(destination, "info", "attributes"))
      await fs.writeFile(
        path.join(destination, "config"),
        "[core]\nrepositoryformatversion = 0\nbare = false\nfilemode = true\nautocrlf = false\n" +
          [...captured.settings].map(([key, value]) => `${key} = ${value}\n`).join("") +
          "fsmonitor = false\nhooksPath = .git/synergy-disabled-hooks\n[gc]\nauto = 0\n[maintenance]\nauto = false\n[commit]\ngpgSign = false\n[tag]\ngpgSign = false\n",
        { mode: 0o600 },
      )
      async function verify() {
        signal?.throwIfAborted()
        if (!active || RuntimeContext.current() !== runtime) fail("git_binding")
        if (checking) throw new Busy({ message: "Git Workspace verification is already in progress" })
        const work = Promise.resolve().then(async () => {
          signal?.throwIfAborted()
          if (!active || RuntimeContext.current() !== runtime) fail("git_binding")
          await using current = await snapshot(source, Global.Path.cache, signal)
          if (current.fingerprint !== fingerprint) changed()
          if (!active || RuntimeContext.current() !== runtime) fail("git_binding")
        })
        checking = work
        try {
          await work
        } finally {
          if (checking === work) checking = undefined
        }
      }
      await verify()
      returned = true
      return Object.freeze({
        gitDirectory: destination,
        verify,
        [Symbol.asyncDispose]: close,
      })
    } finally {
      if (!returned) {
        await close()
      }
    }
  }
}
