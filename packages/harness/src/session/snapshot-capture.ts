import fs from "node:fs/promises"
import { constants, type Stats } from "node:fs"
import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"
import ignore, { type Ignore } from "ignore"
import { RuntimeContext } from "../lifecycle/context"
import { SnapshotLink } from "./snapshot-link"
import { SnapshotGit } from "./snapshot-git"
import type { SnapshotStore } from "./snapshot-store"
import { WorkspaceTree } from "../workspace/tree"
import type { BlobStore } from "../workspace/content"
import type { SnapshotSchema } from "./snapshot-schema"

export namespace SnapshotCapture {
  const MAX_FILE_BYTES = 2 * 1024 * 1024
  const MAX_ENTRIES = 100_000
  const MAX_DEPTH = 256
  const EXCLUDED_DIRS = new Set([
    ".git",
    ".synergy",
    "node_modules",
    "dist",
    "build",
    "target",
    ".next",
    ".nuxt",
    ".cache",
    "coverage",
  ])
  const EXCLUDED_EXTENSIONS = new Set([
    ".zip",
    ".7z",
    ".rar",
    ".tar",
    ".gz",
    ".tgz",
    ".bz2",
    ".xz",
    ".db",
    ".sqlite",
    ".sqlite3",
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".mp3",
    ".mp4",
    ".mov",
    ".avi",
    ".mkv",
    ".bin",
    ".exe",
    ".dll",
    ".dylib",
    ".so",
    ".lock",
  ])
  type Entry = { mode: string; hash: string }
  type Rule = { prefix: string; matcher: Ignore }

  function same(left: Stats, right: Stats) {
    return (
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.mode === right.mode &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.ctimeMs === right.ctimeMs
    )
  }

  async function read(filename: string, expected: Stats, signal: AbortSignal) {
    signal.throwIfAborted()
    const file = await fs.open(
      filename,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK),
    )
    try {
      const before = await file.stat()
      if (!same(expected, before) || !before.isFile()) throw new Error("Snapshot file changed while opening")
      if (before.size > MAX_FILE_BYTES) return undefined
      const bytes = Buffer.alloc(before.size + 1)
      let length = 0
      for (;;) {
        signal.throwIfAborted()
        const chunk = await file.read(bytes, length, bytes.length - length, length)
        length += chunk.bytesRead
        if (!chunk.bytesRead || length === bytes.length) break
      }
      if (length !== before.size || !same(before, await file.stat()))
        throw new Error("Snapshot file changed while reading")
      return bytes.subarray(0, length)
    } finally {
      await file.close()
    }
  }

  function quote(filename: string) {
    return (
      '"' +
      filename.replace(/[\x00-\x1f\x7f"\\]/g, (character) =>
        character === '"' || character === "\\"
          ? "\\" + character
          : "\\" + character.charCodeAt(0).toString(8).padStart(3, "0"),
      ) +
      '"'
    )
  }

  export type Content = { tree: WorkspaceTree.Manifest; store: BlobStore }
  export async function refresh(
    operation: SnapshotStore.Operation,
    signal?: AbortSignal,
    content?: Content,
    onOmissions?: (omissions: SnapshotSchema.Omission[]) => void,
  ) {
    const controller = new AbortController()
    const forward = () => controller.abort(signal?.reason)
    signal?.addEventListener("abort", forward, { once: true })
    if (signal?.aborted) forward()
    const timer = setTimeout(
      () => controller.abort(new DOMException("Snapshot capture timed out", "TimeoutError")),
      60_000,
    )
    try {
      return await refreshImpl(operation, controller.signal, content, onOmissions)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", forward)
    }
  }

  async function refreshImpl(
    operation: SnapshotStore.Operation,
    abort: AbortSignal,
    content?: Content,
    onOmissions?: (omissions: SnapshotSchema.Omission[]) => void,
  ) {
    abort.throwIfAborted()
    const omissions: SnapshotSchema.Omission[] = []
    const omit = (file: string, reason: SnapshotSchema.Omission["reason"]) => {
      if (!onOmissions) throw new Error(`Snapshot file could not be captured: ${file}`)
      omissions.push({ file, reason })
    }
    const root = content ? "" : await fs.realpath(operation.workspace)
    const run = (args: string[], input?: string) =>
      SnapshotGit.run(
        ["git", "--git-dir", operation.repository, ...args],
        path.dirname(operation.repository),
        { GIT_INDEX_FILE: operation.index, GIT_LITERAL_PATHSPECS: "1" },
        abort,
        input,
      )
    const listing = await run(["ls-files", "--stage", "-z"])
    if (listing.exitCode !== 0) throw new Error(`Cannot read snapshot index: ${listing.stderr}`)
    const previous = new Map<string, Entry>()
    const parents = new Set<string>()
    for (const record of listing.text.split("\0")) {
      if (!record) continue
      const separator = record.indexOf("\t")
      const [mode, hash, stage] = record.slice(0, separator).split(" ")
      if (separator < 0 || stage !== "0" || !/^[a-f0-9]{40}$/.test(hash!))
        throw new Error("Invalid snapshot index entry")
      const name = record.slice(separator + 1)
      previous.set(name, { mode: mode!, hash: hash! })
      let parent = path.posix.dirname(name)
      while (parent !== ".") {
        parents.add(parent)
        parent = path.posix.dirname(parent)
      }
    }
    const caseResult = await run(["config", "--bool", "--get", "core.ignorecase"])
    if (![0, 1].includes(caseResult.exitCode)) throw new Error(`Cannot read snapshot case policy: ${caseResult.stderr}`)
    const ignorecase = !content && caseResult.text.trim() === "true"
    const globalResult = await run(["config", "--path", "--get", "core.excludesfile"])
    if (![0, 1].includes(globalResult.exitCode))
      throw new Error(`Cannot read snapshot ignore policy: ${globalResult.stderr}`)
    const env = RuntimeContext.current().host.env
    const globalFile =
      globalResult.text.trim() ||
      path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), ".config"), "git", "ignore")
    const initial: Rule[] = []
    const globalPath = content
      ? undefined
      : await fs.realpath(globalFile).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined
          throw error
        })
    if (globalPath) {
      const globalRules = await read(globalPath, await fs.lstat(globalPath), abort)
      if (!globalRules) throw new Error("Snapshot global ignore file exceeds limit")
      initial.push({ prefix: "", matcher: ignore({ ignorecase }).add(globalRules.toString("utf8")) })
    }
    const directory = await fs.mkdtemp(path.join(operation.temporary, "capture-"))
    const current = new Map<string, Entry>()
    const available = new Set([...previous.values()].map((entry) => entry.hash))
    const pending = new Map<string, string>()
    let pendingBytes = 0
    let count = 0
    const flush = async () => {
      if (!pending.size) return
      // Provenance: https://git-scm.com/docs/git-hash-object (--no-filters).
      // Immutable native bytes bypass attributes, clean filters and timestamp
      // shortcuts; no Git command enters the user's working directory.
      const result = await run(
        ["hash-object", "-w", "--no-filters", "--stdin-paths"],
        [...pending.values()].map(quote).join("\n") + "\n",
      )
      if (result.exitCode !== 0 || result.text.trim() !== [...pending.keys()].join("\n"))
        throw new Error(`Snapshot object write failed: ${result.stderr}`)
      for (const [hash, filename] of pending) {
        available.add(hash)
        await fs.unlink(filename)
      }
      pending.clear()
      pendingBytes = 0
    }
    const retain = async (name: string, mode: string, bytes: Uint8Array) => {
      const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
      current.set(name, { mode, hash })
      if (available.has(hash) || pending.has(hash)) return
      const filename = path.join(directory, hash)
      await fs.writeFile(filename, bytes, { flag: "wx", mode: 0o600 })
      pending.set(hash, filename)
      pendingBytes += bytes.length
      if (pending.size >= 128 || pendingBytes >= 16 * 1024 * 1024) await flush()
    }
    const visit = async (relative: string, inherited: Rule[], ignoredParent: boolean, depth: number): Promise<void> => {
      abort.throwIfAborted()
      if (depth > MAX_DEPTH) throw new Error("Snapshot directory depth exceeds limit")
      const absolute = path.join(root, relative)
      if (path.relative(root, await fs.realpath(absolute)) !== relative.split("/").join(path.sep))
        throw new Error("Snapshot directory changed while reading")
      const rules = [...inherited]
      const ignoreFile = path.join(absolute, ".gitignore")
      const ignoreStat = await fs.lstat(ignoreFile).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (ignoreStat?.isFile()) {
        const bytes = await read(ignoreFile, ignoreStat, abort)
        if (!bytes) throw new Error("Snapshot ignore file exceeds limit")
        // Provenance: https://github.com/kaelzhang/node-ignore#ignoretestpathname-since-500
        // Child rules override parent matches only within an admitted directory.
        rules.push({
          prefix: relative ? relative + "/" : "",
          matcher: ignore({ ignorecase }).add(bytes.toString("utf8")),
        })
      }
      const entries = await fs.opendir(absolute)
      for await (const entry of entries) {
        abort.throwIfAborted()
        if (++count > MAX_ENTRIES) throw new Error("Snapshot entry count exceeds limit")
        if (EXCLUDED_DIRS.has(entry.name) || EXCLUDED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
        const name = relative ? relative + "/" + entry.name : entry.name
        const filename = path.join(root, name)
        const stat = await fs.lstat(filename)
        let ignored = ignoredParent
        if (!ignoredParent)
          for (const rule of rules) {
            const match = rule.matcher.test(name.slice(rule.prefix.length) + (stat.isDirectory() ? "/" : ""))
            if (match.ignored) ignored = true
            else if (match.unignored) ignored = false
          }
        if (stat.isDirectory()) {
          if (!ignored || parents.has(name)) await visit(name, rules, ignored, depth + 1)
          continue
        }
        if (ignored && !previous.has(name)) continue
        if (stat.isSymbolicLink()) {
          const bytes = SnapshotLink.capture(filename, await fs.readlink(filename))
          if (!same(stat, await fs.lstat(filename))) throw new Error("Snapshot symbolic link changed while reading")
          await retain(name, "120000", bytes)
        } else if (stat.isFile()) {
          try {
            const bytes = await read(filename, stat, abort)
            if (bytes) await retain(name, stat.mode & 0o111 ? "100755" : "100644", bytes)
            else if (onOmissions) omit(name, "size_limit")
            else if (previous.has(name)) throw new Error("A recorded file exceeds the snapshot size limit")
          } catch (error) {
            abort.throwIfAborted()
            if (!onOmissions) throw error
            omit(name, "read_failed")
          }
        }
      }
      if (path.relative(root, await fs.realpath(absolute)) !== relative.split("/").join(path.sep))
        throw new Error("Snapshot directory changed while reading")
    }
    const readContent = async (entry: WorkspaceTree.Entry) => {
      if (entry.kind !== "file" || entry.size > MAX_FILE_BYTES) return undefined
      const bytes = new Uint8Array(entry.size)
      let offset = 0
      for (const chunk of entry.chunks) {
        abort.throwIfAborted()
        const data = WorkspaceTree.verify(chunk.hash, await content!.store.get(chunk.hash, chunk.size), chunk.size)
        if (data.length !== chunk.size) throw new Error("Snapshot content chunk is incomplete")
        bytes.set(data, offset)
        offset += data.length
      }
      return Buffer.from(WorkspaceTree.verify(entry.hash, bytes, MAX_FILE_BYTES))
    }
    const visitContent = async (
      relative: string,
      inherited: Rule[],
      ignoredParent: boolean,
      depth: number,
    ): Promise<void> => {
      abort.throwIfAborted()
      if (depth > MAX_DEPTH) throw new Error("Snapshot directory depth exceeds limit")
      const rules = [...inherited]
      const children = WorkspaceTree.children(content!.tree, relative)
      const ignored = children.find((entry) => path.posix.basename(entry.path) === ".gitignore")
      if (ignored?.kind === "file") {
        const bytes = await readContent(ignored)
        if (!bytes) throw new Error("Snapshot ignore file exceeds limit")
        rules.push({
          prefix: relative ? relative + "/" : "",
          matcher: ignore({ ignorecase: false }).add(bytes.toString("utf8")),
        })
      }
      for (const entry of children) {
        abort.throwIfAborted()
        if (++count > MAX_ENTRIES) throw new Error("Snapshot entry count exceeds limit")
        const name = path.posix.basename(entry.path)
        if (EXCLUDED_DIRS.has(name) || EXCLUDED_EXTENSIONS.has(path.posix.extname(name).toLowerCase())) continue
        let excluded = ignoredParent
        if (!ignoredParent)
          for (const rule of rules) {
            const match = rule.matcher.test(
              entry.path.slice(rule.prefix.length) + (entry.kind === "directory" ? "/" : ""),
            )
            if (match.ignored) excluded = true
            else if (match.unignored) excluded = false
          }
        if (entry.kind === "directory") {
          if (!excluded || parents.has(entry.path)) await visitContent(entry.path, rules, excluded, depth + 1)
        } else if (!excluded || previous.has(entry.path)) {
          if (entry.kind === "symlink")
            await retain(entry.path, "120000", SnapshotLink.encode({ target: entry.target }))
          else {
            try {
              const bytes = await readContent(entry)
              if (bytes) await retain(entry.path, entry.mode & 0o111 ? "100755" : "100644", bytes)
              else if (onOmissions) omit(entry.path, "size_limit")
              else if (previous.has(entry.path)) throw new Error("A recorded file exceeds the snapshot size limit")
            } catch (error) {
              abort.throwIfAborted()
              if (!onOmissions) throw error
              omit(entry.path, "read_failed")
            }
          }
        }
      }
    }
    try {
      if (content) await visitContent("", [], false, 0)
      else await visit("", initial, false, 0)
      onOmissions?.(omissions)
      await flush()
      const updates: string[] = []
      for (const name of previous.keys()) if (!current.has(name)) updates.push(`0 ${"0".repeat(40)}\t${name}\0`)
      for (const [name, entry] of current) {
        const before = previous.get(name)
        if (before?.mode !== entry.mode || before?.hash !== entry.hash)
          updates.push(`${entry.mode} ${entry.hash}\t${name}\0`)
      }
      if (!updates.length) return true
      // Provenance: https://git-scm.com/docs/git-update-index#_using_index_info
      // NUL records preserve literal names and apply removals before D/F changes.
      const result = await run(["update-index", "-z", "--index-info"], updates.join(""))
      if (result.exitCode !== 0) throw new Error(`Snapshot index write failed: ${result.stderr}`)
      return true
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
}
