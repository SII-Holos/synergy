import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { $ } from "bun"
import type { BunFile } from "bun"
import { formatPatch, structuredPatch } from "diff"
import path from "path"
import fs from "fs"
import ignore from "ignore"
import { Log } from "../util/log"
import { ScopeContext } from "../scope/context"
import fuzzysort from "fuzzysort"
import { WorkspaceFileIndexer } from "../workspace-file/indexer"

export namespace File {
  const log = Log.create({ service: "file" })

  export const Info = z
    .object({
      path: z.string(),
      added: z.number().int(),
      removed: z.number().int(),
      status: z.enum(["added", "deleted", "modified"]),
    })
    .meta({
      ref: "File",
    })

  export type Info = z.infer<typeof Info>

  export const Node = z
    .object({
      name: z.string(),
      path: z.string(),
      absolute: z.string(),
      type: z.enum(["file", "directory"]),
      ignored: z.boolean(),
    })
    .meta({
      ref: "FileNode",
    })
  export type Node = z.infer<typeof Node>

  export const Content = z
    .object({
      type: z.literal("text"),
      content: z.string(),
      diff: z.string().optional(),
      patch: z
        .object({
          oldFileName: z.string(),
          newFileName: z.string(),
          oldHeader: z.string().optional(),
          newHeader: z.string().optional(),
          hunks: z.array(
            z.object({
              oldStart: z.number(),
              oldLines: z.number(),
              newStart: z.number(),
              newLines: z.number(),
              lines: z.array(z.string()),
            }),
          ),
          index: z.string().optional(),
        })
        .optional(),
      encoding: z.literal("base64").optional(),
      mimeType: z.string().optional(),
    })
    .meta({
      ref: "FileContent",
    })
  export type Content = z.infer<typeof Content>

  async function shouldEncode(file: BunFile): Promise<boolean> {
    const type = file.type?.toLowerCase()
    log.info("shouldEncode", { type })
    if (!type) return false

    if (type.startsWith("text/")) return false
    if (type.includes("charset=")) return false

    const parts = type.split("/", 2)
    const top = parts[0]
    const rest = parts[1] ?? ""
    const sub = rest.split(";", 1)[0]

    const tops = ["image", "audio", "video", "font", "model", "multipart"]
    if (tops.includes(top)) return true

    const bins = [
      "zip",
      "gzip",
      "bzip",
      "compressed",
      "binary",
      "pdf",
      "msword",
      "powerpoint",
      "excel",
      "ogg",
      "exe",
      "dmg",
      "iso",
      "rar",
    ]
    if (bins.some((mark) => sub.includes(mark))) return true

    return false
  }

  export const Event = {
    Edited: BusEvent.define(
      "file.edited",
      z.object({
        file: z.string(),
      }),
    ),
  }

  async function homeSearchEntries() {
    const dirs = new Set<string>()
    const ignored = new Set<string>()

    if (process.platform === "darwin") ignored.add("Library")
    if (process.platform === "win32") ignored.add("AppData")

    const ignoreNested = new Set(["node_modules", "dist", "build", "target", "vendor"])
    const shouldIgnore = (name: string) => name.startsWith(".") || ignored.has(name)
    const shouldIgnoreNested = (name: string) => name.startsWith(".") || ignoreNested.has(name)
    const top = await fs.promises
      .readdir(ScopeContext.current.directory, { withFileTypes: true })
      .catch(() => [] as fs.Dirent[])

    for (const entry of top) {
      if (!entry.isDirectory() || shouldIgnore(entry.name)) continue
      dirs.add(entry.name + "/")

      const base = path.join(ScopeContext.current.directory, entry.name)
      const children = await fs.promises.readdir(base, { withFileTypes: true }).catch(() => [] as fs.Dirent[])
      for (const child of children) {
        if (!child.isDirectory() || shouldIgnoreNested(child.name)) continue
        dirs.add(entry.name + "/" + child.name + "/")

        const childBase = path.join(base, child.name)
        const grandchildren = await fs.promises
          .readdir(childBase, { withFileTypes: true })
          .catch(() => [] as fs.Dirent[])
        for (const grandchild of grandchildren) {
          if (!grandchild.isDirectory() || shouldIgnoreNested(grandchild.name)) continue
          dirs.add(entry.name + "/" + child.name + "/" + grandchild.name + "/")
        }
      }
    }

    return { files: [] as string[], dirs: Array.from(dirs).toSorted() }
  }

  async function searchEntries() {
    const directory = ScopeContext.current.directory
    if (directory === path.parse(directory).root) return { files: [] as string[], dirs: [] as string[] }
    if (ScopeContext.current.scope.type === "home") return homeSearchEntries()
    const snapshot = await WorkspaceFileIndexer.snapshot()
    return { files: snapshot.files, dirs: snapshot.dirs }
  }

  export async function status() {
    const scope = ScopeContext.current.scope
    if (scope.type !== "project" || scope.vcs !== "git") return []

    const diffOutput = await $`git diff --numstat HEAD`.cwd(ScopeContext.current.directory).quiet().nothrow().text()

    const changedFiles: Info[] = []

    if (diffOutput.trim()) {
      const lines = diffOutput.trim().split("\n")
      for (const line of lines) {
        const [added, removed, filepath] = line.split("\t")
        changedFiles.push({
          path: filepath,
          added: added === "-" ? 0 : parseInt(added, 10),
          removed: removed === "-" ? 0 : parseInt(removed, 10),
          status: "modified",
        })
      }
    }

    const untrackedOutput = await $`git ls-files --others --exclude-standard`
      .cwd(ScopeContext.current.directory)
      .quiet()
      .nothrow()
      .text()

    if (untrackedOutput.trim()) {
      const untrackedFiles = untrackedOutput.trim().split("\n")
      for (const filepath of untrackedFiles) {
        try {
          const content = await Bun.file(path.join(ScopeContext.current.directory, filepath)).text()
          const lines = content.split("\n").length
          changedFiles.push({
            path: filepath,
            added: lines,
            removed: 0,
            status: "added",
          })
        } catch {
          continue
        }
      }
    }

    // Get deleted files
    const deletedOutput = await $`git diff --name-only --diff-filter=D HEAD`
      .cwd(ScopeContext.current.directory)
      .quiet()
      .nothrow()
      .text()

    if (deletedOutput.trim()) {
      const deletedFiles = deletedOutput.trim().split("\n")
      for (const filepath of deletedFiles) {
        changedFiles.push({
          path: filepath,
          added: 0,
          removed: 0, // Could get original line count but would require another git command
          status: "deleted",
        })
      }
    }

    return changedFiles.map((x) => ({
      ...x,
      path: path.relative(ScopeContext.current.directory, x.path),
    }))
  }

  export async function read(file: string): Promise<Content> {
    using _ = log.time("read", { file })
    const scope = ScopeContext.current.scope
    const full = path.join(ScopeContext.current.directory, file)

    // TODO: ScopeContext.contains is lexical only - symlinks inside the project can escape.
    // TODO: On Windows, cross-drive paths bypass this check. Consider realpath canonicalization.
    if (!ScopeContext.contains(full)) {
      throw new Error(`Access denied: path escapes project directory`)
    }

    const bunFile = Bun.file(full)

    if (!(await bunFile.exists())) {
      return { type: "text", content: "" }
    }

    const encode = await shouldEncode(bunFile)

    if (encode) {
      const buffer = await bunFile.arrayBuffer().catch(() => new ArrayBuffer(0))
      const content = Buffer.from(buffer).toString("base64")
      const mimeType = bunFile.type || "application/octet-stream"
      return { type: "text", content, mimeType, encoding: "base64" }
    }

    const content = await bunFile
      .text()
      .catch(() => "")
      .then((x) => x.trim())

    if (scope.type === "project" && scope.vcs === "git") {
      let diff = await $`git diff ${file}`.cwd(ScopeContext.current.directory).quiet().nothrow().text()
      if (!diff.trim())
        diff = await $`git diff --staged ${file}`.cwd(ScopeContext.current.directory).quiet().nothrow().text()
      if (diff.trim()) {
        const original = await $`git show HEAD:${file}`.cwd(ScopeContext.current.directory).quiet().nothrow().text()
        const patch = structuredPatch(file, file, original, content, "old", "new", {
          context: Infinity,
          ignoreWhitespace: true,
        })
        const diff = formatPatch(patch)
        return { type: "text", content, patch, diff }
      }
    }
    return { type: "text", content }
  }

  export async function list(dir?: string) {
    const exclude = [".git", ".DS_Store"]
    const scope = ScopeContext.current.scope
    let ignored = (_: string) => false
    if (scope.type === "project" && scope.vcs === "git") {
      const ig = ignore()
      const gitignore = Bun.file(path.join(ScopeContext.current.directory, ".gitignore"))
      if (await gitignore.exists()) {
        ig.add(await gitignore.text())
      }
      const ignoreFile = Bun.file(path.join(ScopeContext.current.directory, ".ignore"))
      if (await ignoreFile.exists()) {
        ig.add(await ignoreFile.text())
      }
      ignored = ig.ignores.bind(ig)
    }
    const resolved = dir ? path.join(ScopeContext.current.directory, dir) : ScopeContext.current.directory

    // TODO: ScopeContext.contains is lexical only - symlinks inside the project can escape.
    // TODO: On Windows, cross-drive paths bypass this check. Consider realpath canonicalization.
    if (!ScopeContext.contains(resolved)) {
      throw new Error(`Access denied: path escapes project directory`)
    }

    const nodes: Node[] = []
    for (const entry of await fs.promises
      .readdir(resolved, {
        withFileTypes: true,
      })
      .catch(() => [])) {
      if (exclude.includes(entry.name)) continue
      const fullPath = path.join(resolved, entry.name)
      const relativePath = path.relative(ScopeContext.current.directory, fullPath)
      const type = entry.isDirectory() ? "directory" : "file"
      nodes.push({
        name: entry.name,
        path: relativePath,
        absolute: fullPath,
        type,
        ignored: ignored(type === "directory" ? relativePath + "/" : relativePath),
      })
    }
    return nodes.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === "directory" ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
  }

  type BrowseCandidate = {
    path: string
    depth: number
    priority: number
    fuzzyScore: number
    name: string
  }

  const browseExcludeNames = new Set([
    "node_modules",
    "dist",
    "build",
    "target",
    "vendor",
    ".git",
    ".ds_store",
    "appdata",
    "application data",
    "local settings",
    "$recycle.bin",
    "system volume information",
    ".cache",
    ".npm",
    ".pnpm-store",
    ".yarn",
    ".cargo",
    ".rustup",
    ".gradle",
    ".m2",
    ".nuget",
    ".vscode",
    ".cursor",
    ".idea",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".turbo",
    ".parcel-cache",
    "out",
    "coverage",
  ])

  function normalizeBrowsePath(value: string) {
    const normalized = value.trim().replace(/\\/g, "/")
    const driveRoot = normalized.match(/^([A-Za-z]):(?:\/)?$/)
    if (driveRoot) return `${driveRoot[1]}:/`
    if (/^[A-Za-z]:\//.test(normalized)) return normalized
    if (normalized.startsWith("//")) return `//${normalized.slice(2).replace(/\/+/g, "/")}`
    return normalized || "/"
  }

  function isHiddenDirectory(name: string) {
    return name.startsWith(".") && name.length > 1
  }

  function shouldSkipBrowseDirectory(name: string, preferHidden: boolean) {
    const key = name.toLowerCase()
    if (browseExcludeNames.has(key)) return true
    if (!preferHidden && isHiddenDirectory(name)) return true
    return false
  }

  async function readBrowseChildren(dir: string, preferHidden: boolean) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [] as fs.Dirent[])
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .filter((entry) => !shouldSkipBrowseDirectory(entry.name, preferHidden))
      .map((entry) => ({ name: entry.name, path: path.join(dir, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  function scoreBrowseCandidate(
    base: string,
    dir: string,
    name: string,
    depth: number,
    query: string,
  ): BrowseCandidate | undefined {
    const normalizedQuery = query.toLowerCase()
    const normalizedName = name.toLowerCase()
    const relative = path.relative(base, dir) || name
    const normalizedRelative = relative.replace(/\\/g, "/").toLowerCase()
    if (normalizedName === normalizedQuery) return { path: dir, depth, priority: 0, fuzzyScore: 0, name }
    if (normalizedName.startsWith(normalizedQuery)) return { path: dir, depth, priority: 1, fuzzyScore: 0, name }
    if (normalizedName.includes(normalizedQuery) || normalizedRelative.includes(normalizedQuery)) {
      return { path: dir, depth, priority: 2, fuzzyScore: 0, name }
    }
    const fuzzy = fuzzysort.single(query, normalizedRelative)
    if (!fuzzy) return undefined
    return { path: dir, depth, priority: 3, fuzzyScore: fuzzy.score, name }
  }

  function sortBrowseCandidates(candidates: BrowseCandidate[]) {
    return candidates.toSorted((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      if (a.depth !== b.depth) return a.depth - b.depth
      if (a.fuzzyScore !== b.fuzzyScore) return b.fuzzyScore - a.fuzzyScore
      return a.name.localeCompare(b.name)
    })
  }

  async function narrowBrowseBase(base: string, query: string) {
    if (!/[\\/]/.test(query)) return { base, query }
    const normalizedQuery = query.replace(/\\/g, "/").replace(/^\/+/, "")
    const parts = normalizedQuery.split("/").filter(Boolean)
    let current = base
    for (let index = 0; index < parts.length - 1; index++) {
      const next = path.join(current, parts[index])
      const stat = await fs.promises.stat(next).catch(() => null)
      if (!stat?.isDirectory()) break
      current = next
    }
    const relative = path.relative(base, current).replace(/\\/g, "/")
    const consumed = relative ? relative.split("/").filter(Boolean).length : 0
    return { base: current, query: parts.slice(consumed).join(" ") || parts.at(-1) || "" }
  }

  export async function browse(input: {
    path: string
    query?: string
    limit?: number
    depth?: number
    maxVisitedDirs?: number
    maxElapsedMs?: number
    maxQueueSize?: number
  }) {
    let base = normalizeBrowsePath(input.path)
    let query = (input.query ?? "").trim()
    const limit = Math.max(0, input.limit ?? 50)
    const maxDepth = Math.max(0, input.depth ?? 4)
    const maxVisitedDirs = input.maxVisitedDirs ?? 2000
    const maxElapsedMs = input.maxElapsedMs ?? 250
    const maxQueueSize = input.maxQueueSize ?? 5000
    const maxCandidates = Math.max(limit, limit * 10)
    if (limit === 0) return []

    const narrowed = await narrowBrowseBase(base, query)
    base = narrowed.base
    query = narrowed.query.trim()

    const stat = await fs.promises.stat(base).catch(() => null)
    if (!stat || !stat.isDirectory()) return []

    const preferHidden = query.startsWith(".") || query.includes("/.") || query.includes("\\.")
    const directChildren = await readBrowseChildren(base, preferHidden)
    if (!query) return directChildren.slice(0, limit).map((entry) => entry.path)

    const started = performance.now()
    const candidates: BrowseCandidate[] = []
    const seen = new Set<string>()
    const queue: Array<{ path: string; depth: number }> = []
    let queueIndex = 0
    let visited = 0

    function addCandidate(candidate: BrowseCandidate | undefined) {
      if (!candidate || seen.has(candidate.path)) return
      seen.add(candidate.path)
      candidates.push(candidate)
      if (candidates.length > maxCandidates) {
        candidates.splice(0, candidates.length, ...sortBrowseCandidates(candidates).slice(0, maxCandidates))
      }
    }

    for (const child of directChildren) {
      addCandidate(scoreBrowseCandidate(base, child.path, child.name, 0, query))
      if (maxDepth > 0 && queue.length < maxQueueSize) queue.push({ path: child.path, depth: 1 })
    }

    while (queueIndex < queue.length && visited < maxVisitedDirs && performance.now() - started < maxElapsedMs) {
      const current = queue[queueIndex++]
      if (current.depth > maxDepth) continue
      visited++
      const children = await readBrowseChildren(current.path, preferHidden)
      for (const child of children) {
        addCandidate(scoreBrowseCandidate(base, child.path, child.name, current.depth, query))
        if (current.depth < maxDepth && queue.length < maxQueueSize)
          queue.push({ path: child.path, depth: current.depth + 1 })
      }
    }

    return sortBrowseCandidates(candidates)
      .slice(0, limit)
      .map((candidate) => candidate.path)
  }

  export async function search(input: { query: string; limit?: number; dirs?: boolean; type?: "file" | "directory" }) {
    const query = input.query.trim()
    const limit = input.limit ?? 100
    const kind = input.type ?? (input.dirs === false ? "file" : "all")
    log.info("search", { query, kind })

    const result = await searchEntries()

    const hidden = (item: string) => {
      const normalized = item.replaceAll("\\", "/").replace(/\/+$/, "")
      return normalized.split("/").some((p) => p.startsWith(".") && p.length > 1)
    }
    const preferHidden = query.startsWith(".") || query.includes("/.")
    const sortHiddenLast = (items: string[]) => {
      if (preferHidden) return items
      const visible: string[] = []
      const hiddenItems: string[] = []
      for (const item of items) {
        const isHidden = hidden(item)
        if (isHidden) hiddenItems.push(item)
        if (!isHidden) visible.push(item)
      }
      return [...visible, ...hiddenItems]
    }
    if (!query) {
      if (kind === "file") return result.files.slice(0, limit)
      return sortHiddenLast(result.dirs.toSorted()).slice(0, limit)
    }

    const items =
      kind === "file" ? result.files : kind === "directory" ? result.dirs : [...result.files, ...result.dirs]

    const searchLimit = kind === "directory" && !preferHidden ? limit * 20 : limit
    const sorted = fuzzysort.go(query, items, { limit: searchLimit }).map((r) => r.target)
    const output = kind === "directory" ? sortHiddenLast(sorted).slice(0, limit) : sorted

    log.info("search", { query, kind, results: output.length })
    return output
  }
}
