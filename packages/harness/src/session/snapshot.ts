import path from "path"
import fs from "fs/promises"
import { Log } from "../util/log"
import { z } from "zod"
import { Config } from "../config/config"
import { ScopeContext } from "../scope/context"
import { SnapshotSchema } from "./snapshot-schema"
import { SnapshotGit } from "./snapshot-git"
import { SnapshotStore } from "./snapshot-store"
import { Storage } from "../storage/storage"
import { SnapshotRestore } from "./snapshot-restore"
import { WorkspaceBinding } from "../workspace/binding"
import { ObservabilityMetrics } from "../observability/metrics"

export namespace Snapshot {
  const log = Log.create({ service: "snapshot" })
  const SNAPSHOT_MAX_FILE_BYTES = 2 * 1024 * 1024
  const CANDIDATE_STATE_CONCURRENCY = 32
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

  async function gitSpawn(...args: Parameters<typeof SnapshotGit.run>) {
    const context = SnapshotStore.current()
    args[2] = { ...args[2], GIT_INDEX_FILE: context.index, GIT_LITERAL_PATHSPECS: "1" }
    return SnapshotGit.run(...args)
  }

  export async function track(sessionID: string, signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted) return
    const source = workspace()
    if (!source) return
    await WorkspaceBinding.validate(source.id, ScopeContext.current.scope.id, source.generation)
    if ((await Config.current()).snapshot === false) return
    try {
      return await SnapshotStore.withSession(sessionID, () => trackImpl(sessionID, signal), signal)
    } catch (error) {
      if (signal?.aborted) return undefined
      throw error
    }
  }

  export function workspace(): SnapshotSchema.Workspace | undefined {
    const source = ScopeContext.current.workspace
    if (!source?.id || !source.generation || source.bindingState === "unbound") return
    return { id: source.id, generation: source.generation, root: source.path }
  }

  async function trackImpl(sessionID: string, signal?: AbortSignal): Promise<string | undefined> {
    if (signal?.aborted) return
    const started = Date.now()
    log.debug("track start", { sessionID, cwd: ScopeContext.current.directory })
    const git = gitdir()
    await SnapshotStore.initialize(SnapshotStore.current())
    // ensureExclude runs inside refreshIndex (which every snapshot path funnels
    // through), so it need not be repeated here.
    const addResult = await refreshIndex(sessionID, signal)
    if (!addResult) {
      log.warn("track add failed", { sessionID, duration: Date.now() - started })
      return undefined
    }
    const writeResult = await gitSpawn(
      ["git", "--git-dir", git, "--work-tree", ScopeContext.current.directory, "write-tree"],
      ScopeContext.current.directory,
      undefined,
      signal,
    )
    if (writeResult.exitCode !== 0 || !writeResult.text.trim()) {
      log.warn("track write-tree failed", { sessionID, exitCode: writeResult.exitCode, duration: Date.now() - started })
      return undefined
    }
    const source = workspace()!
    await WorkspaceBinding.validate(source.id, ScopeContext.current.scope.id, source.generation)
    const hash = writeResult.text.trim()
    if (!(await SnapshotStore.retainCurrent(hash, signal))) return undefined
    log.info("tracking", { hash, cwd: ScopeContext.current.directory, git, duration: Date.now() - started })
    ObservabilityMetrics.record({
      name: "snapshot.track.duration",
      value: Date.now() - started,
      unit: "ms",
      module: "session",
      sessionID,
    })
    return hash
  }

  type IndexOptions = { indexFresh?: boolean; signal?: AbortSignal }

  export async function patch(hash: string, sessionID: string, options?: IndexOptions): Promise<Patch> {
    if (options?.signal?.aborted) return { hash, files: [] }
    return SnapshotStore.withSession(
      sessionID,
      async () => {
        if (!(await SnapshotStore.ownsCurrent(hash))) return { hash, files: [] }
        return patchImpl(hash, sessionID, options)
      },
      options?.signal,
    ).catch((error) => {
      if (options?.signal?.aborted) return { hash, files: [] }
      throw error
    })
  }

  export async function diff(hash: string, sessionID: string, options?: IndexOptions) {
    if (options?.signal?.aborted) return ""
    return SnapshotStore.withSession(
      sessionID,
      async () => {
        if (!(await SnapshotStore.ownsCurrent(hash))) return ""
        return diffImpl(hash, sessionID, options)
      },
      options?.signal,
    ).catch((error) => {
      if (options?.signal?.aborted) return ""
      throw error
    })
  }

  export async function diffSummary(from: string, to: string, sessionID: string, signal?: AbortSignal) {
    if (signal?.aborted) return []
    return SnapshotStore.withSession(
      sessionID,
      async () => {
        if (!(await SnapshotStore.ownsCurrent(from)) || !(await SnapshotStore.ownsCurrent(to))) return []
        return diffSummaryImpl(from, to, sessionID, signal)
      },
      signal,
      { historical: true },
    ).catch((error) => {
      if (signal?.aborted) return []
      throw error
    })
  }

  export async function revert(
    patches: Patch[],
    sessionID: string,
    signal?: AbortSignal,
  ): Promise<SnapshotRestore.Result> {
    if (!patches.some((patch) => patch.files.length)) return { restoredFiles: [], failedFiles: [] }
    return SnapshotStore.withSession(
      sessionID,
      async () => {
        const files = new Map<string, SnapshotRestore.File>()
        const trees = new Map<string, Map<string, { mode: string; oid: string }>>()
        for (const patch of patches) {
          if (!patch.files.length) continue
          const source = patch.workspace
          if (!source)
            throw new SnapshotRestore.Invalid({ message: "This historical patch has no verified Workspace binding" })
          const binding = await WorkspaceBinding.validate(source.id, ScopeContext.current.scope.id, source.generation)
          if (binding.path !== source.root)
            throw new SnapshotRestore.Invalid({
              message: "The historical Workspace location does not match its binding",
            })
          if (!(await SnapshotStore.ownsCurrent(patch.hash)))
            throw new SnapshotRestore.Invalid({
              message: "The historical file snapshot is unavailable to this session",
            })
          let tree = trees.get(patch.hash)
          if (!tree) {
            const listing = await gitSpawn(
              ["git", "--git-dir", gitdir(), "ls-tree", "-r", "-l", "-z", patch.hash],
              path.dirname(gitdir()),
              undefined,
              signal,
            )
            if (listing.exitCode !== 0)
              throw new SnapshotRestore.Invalid({ message: "The historical file tree could not be read" })
            tree = new Map(
              listing.text
                .split("\0")
                .filter(Boolean)
                .map((entry) => {
                  const boundary = entry.indexOf("\t")
                  const [mode, kind, oid, size] = entry.slice(0, boundary).trim().split(/\s+/)
                  if (boundary < 0 || !SnapshotStore.OID.test(oid))
                    throw new SnapshotRestore.Invalid({
                      message: "The historical file tree contains an unsupported entry",
                    })
                  return [
                    entry.slice(boundary + 1),
                    { mode: kind === "blob" && Number(size) <= 50 * 1024 * 1024 ? mode : "unsupported", oid },
                  ]
                }),
            )
            trees.set(patch.hash, tree)
          }
          for (const file of patch.files) {
            signal?.throwIfAborted()
            const relative = path.relative(source.root, file)
            if (
              !path.isAbsolute(file) ||
              !relative ||
              relative === ".." ||
              relative.startsWith(`..${path.sep}`) ||
              path.isAbsolute(relative)
            )
              throw new SnapshotRestore.Invalid({ message: "A historical file is outside its Workspace" })
            const normalized = path.normalize(file)
            if (files.has(normalized)) continue
            const entry = tree.get(process.platform === "win32" ? relative.replaceAll("\\", "/") : relative)
            if (entry && !["100644", "100755", "120000"].includes(entry.mode))
              throw new SnapshotRestore.Invalid({ message: "This snapshot file mode cannot be restored" })
            files.set(normalized, {
              file: normalized,
              workspace: source,
              mode: entry ? (entry.mode as "100644" | "100755" | "120000") : null,
              async read() {
                if (!entry) return new Uint8Array()
                const result = await gitSpawn(
                  ["git", "--git-dir", gitdir(), "cat-file", "blob", entry.oid],
                  path.dirname(gitdir()),
                  undefined,
                  signal,
                )
                if (result.exitCode !== 0)
                  throw new SnapshotRestore.Invalid({ message: "The historical file content is unavailable" })
                return result.bytes
              },
            })
          }
        }
        return SnapshotRestore.apply({ files: [...files.values()], signal })
      },
      signal,
      { historical: true },
    )
  }

  export const Patch = z.object({
    hash: z.string(),
    workspace: SnapshotSchema.Workspace.optional(),
    files: z.string().array(),
  })
  export type Patch = z.infer<typeof Patch>

  async function patchImpl(hash: string, sessionID: string, opts?: IndexOptions): Promise<Patch> {
    if (opts?.signal?.aborted) return { hash, files: [] }
    const started = Date.now()
    log.debug("patch start", { sessionID, hash })
    const git = gitdir()
    if (!opts?.indexFresh) {
      const addResult = await refreshIndex(sessionID, opts?.signal)
      if (!addResult) {
        log.warn("patch add failed", { sessionID, hash, duration: Date.now() - started })
        return { hash, files: [] }
      }
    }
    if (opts?.signal?.aborted) return { hash, files: [] }
    const diffResult = await gitSpawn(
      [
        "git",
        "-c",
        "core.autocrlf=false",
        "--git-dir",
        git,
        "--work-tree",
        ScopeContext.current.directory,
        "diff",
        "--no-ext-diff",
        "--name-only",
        "--cached",
        "-z",
        hash,
        "--",
        ".",
      ],
      ScopeContext.current.directory,
      undefined,
      opts?.signal,
    )

    if (diffResult.exitCode !== 0) {
      log.warn("failed to get diff", {
        sessionID,
        hash,
        exitCode: diffResult.exitCode,
        stderr: diffResult.stderr,
        duration: Date.now() - started,
      })
      return { hash, files: [] }
    }

    const filesText = diffResult.text
    log.debug("patch done", { sessionID, hash, duration: Date.now() - started })
    ObservabilityMetrics.record({
      name: "snapshot.patch.duration",
      value: Date.now() - started,
      unit: "ms",
      module: "session",
      sessionID,
    })
    return {
      hash,
      workspace: workspace(),
      files: filesText.split("\0").filter(Boolean).map(absoluteWorktreePath),
    }
  }

  async function diffImpl(hash: string, sessionID: string, opts?: IndexOptions) {
    const git = gitdir()
    if (!opts?.indexFresh) await refreshIndex(sessionID, opts?.signal)
    const result = await gitSpawn(
      [
        "git",
        "-c",
        "core.autocrlf=false",
        "--git-dir",
        git,
        "--work-tree",
        ScopeContext.current.directory,
        "diff",
        "--no-ext-diff",
        "--cached",
        hash,
        "--",
        ".",
      ],
      ScopeContext.current.directory,
      undefined,
      opts?.signal,
    )

    if (result.exitCode !== 0) {
      log.warn("failed to get diff", {
        hash,
        exitCode: result.exitCode,
        stderr: result.stderr,
        stdout: result.text,
      })
      return ""
    }

    return result.text.trim()
  }

  export const FileDiff = SnapshotSchema.FileDiff
  export type FileDiff = SnapshotSchema.FileDiff
  async function diffSummaryImpl(
    from: string,
    to: string,
    sessionID: string,
    signal?: AbortSignal,
  ): Promise<FileDiff[]> {
    const git = gitdir()
    const result: FileDiff[] = []
    const diff = await gitSpawn(
      [
        "git",
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.quotepath=false",
        "--git-dir",
        git,
        "diff",
        "--no-ext-diff",
        "--no-renames",
        "--numstat",
        "-p",
        "-z",
        from,
        to,
        "--",
        ".",
      ],
      path.dirname(git),
      undefined,
      signal,
    )
    if (diff.exitCode !== 0) {
      log.warn("failed to get diff summary", { from, to, exitCode: diff.exitCode, stderr: diff.stderr })
      return result
    }

    const parsed = parseNumstatPatch(diff.text)
    const sizes = await objectSizes(
      git,
      parsed.stats.flatMap((stat) => [
        { tree: from, file: stat.file },
        { tree: to, file: stat.file },
      ]),
      signal,
    )
    for (let index = 0; index < parsed.stats.length; index++) {
      const stat = parsed.stats[index]
      const { additions, deletions, file } = stat
      const isBinaryFile = additions === "-" && deletions === "-"
      const added = isBinaryFile ? 0 : parseInt(additions)
      const deleted = isBinaryFile ? 0 : parseInt(deletions)
      const patch = isBinaryFile ? "" : (parsed.patches[index] ?? "")
      result.push(
        SnapshotSchema.fromPatch({
          file,
          additions: Number.isFinite(added) ? added : 0,
          deletions: Number.isFinite(deleted) ? deleted : 0,
          binary: isBinaryFile,
          patch,
          beforeBytes: sizes.get(objectSizeKey(from, file)),
          afterBytes: sizes.get(objectSizeKey(to, file)),
        }),
      )
    }
    return SnapshotSchema.boundArray(result)
  }

  async function refreshIndex(sessionID: string, signal?: AbortSignal): Promise<boolean> {
    const git = gitdir()
    const cwd = ScopeContext.current.directory
    await ensureExclude(git)

    const changed = await changedFiles(git, cwd, signal)
    if (changed === undefined) return false
    if (changed.length === 0) return true

    const addable: string[] = []
    const removable: string[] = []
    // Classify candidates with bounded-concurrency lstat rather than a serial
    // await-per-file loop, so the (one-time) first-track scan over a large repo
    // doesn't stall the event loop or exhaust file descriptors.
    const states = await mapWithConcurrency(changed, CANDIDATE_STATE_CONCURRENCY, (rel) => candidateState(cwd, rel))
    for (let i = 0; i < changed.length; i++) {
      // "missing" (deleted from the work tree) is staged for removal via the
      // `git add --all` below, so it belongs with the addable pathspec.
      if (states[i] === "remove") removable.push(changed[i])
      else addable.push(changed[i])
    }

    if (removable.length > 0) {
      // Provenance: https://git-scm.com/docs/git-update-index/2.25.0
      // Remove literal NUL-delimited paths from only the snapshot index; older
      // Git supports this form but not git rm --pathspec-from-file.
      const rm = await gitSpawn(
        ["git", "--git-dir", git, "--work-tree", cwd, "update-index", "--force-remove", "-z", "--stdin"],
        cwd,
        undefined,
        signal,
        removable.join("\0") + "\0",
      )
      if (rm.exitCode !== 0) return false
    }

    if (addable.length === 0) return true

    const pathspec = path.join(SnapshotStore.current().temporary, "add-pathspec")
    await fs.writeFile(pathspec, addable.join("\0") + "\0")
    try {
      const add = await gitSpawn(
        [
          "git",
          "--git-dir",
          git,
          "--work-tree",
          cwd,
          "add",
          "--all",
          "--pathspec-from-file",
          pathspec,
          "--pathspec-file-nul",
        ],
        cwd,
        undefined,
        signal,
      )
      return add.exitCode === 0
    } finally {
      await fs.unlink(pathspec).catch(() => undefined)
    }
  }

  // Only the files that actually changed since the shadow index was last
  // refreshed. This must not depend on HEAD: the shadow repo only ever
  // `write-tree`s and never commits, so its HEAD is unborn and `git status`
  // would report every indexed file as a staged addition — forcing a full
  // rescan every step. `diff-files` (work tree vs. index) plus
  // `ls-files --others` (new untracked) give the true delta independent of
  // HEAD. A worktree rename surfaces as a delete of the old path (diff-files)
  // plus a new untracked path (ls-files), which is exactly what the index
  // update needs, so no explicit rename handling is required. With `-z`,
  // paths are emitted verbatim (no quoting), so core.quotepath is irrelevant.
  async function changedFiles(git: string, cwd: string, signal?: AbortSignal): Promise<string[] | undefined> {
    const modified = await gitSpawn(
      ["git", "--git-dir", git, "--work-tree", cwd, "diff-files", "--name-only", "-z"],
      cwd,
      undefined,
      signal,
    )
    if (modified.exitCode !== 0) {
      log.warn("diff-files failed", { cwd, exitCode: modified.exitCode, stderr: modified.stderr })
      return undefined
    }
    const untracked = await gitSpawn(
      ["git", "--git-dir", git, "--work-tree", cwd, "ls-files", "--others", "--exclude-standard", "-z"],
      cwd,
      undefined,
      signal,
    )
    if (untracked.exitCode !== 0) {
      log.warn("ls-files failed", { cwd, exitCode: untracked.exitCode, stderr: untracked.stderr })
      return undefined
    }
    const files = new Set<string>()
    for (const raw of [...modified.text.split("\0"), ...untracked.text.split("\0")]) {
      if (raw) files.add(raw)
    }
    return [...files]
  }

  async function candidateState(cwd: string, rel: string): Promise<"add" | "remove" | "missing"> {
    if (excludePath(rel)) return "remove"
    const absolute = path.join(cwd, rel)
    const stat = await fs.lstat(absolute).catch(() => undefined)
    if (!stat) return "missing"
    if (!stat.isFile() && !stat.isSymbolicLink()) return "remove"
    if (stat.isFile() && stat.size > SNAPSHOT_MAX_FILE_BYTES) return "remove"
    return "add"
  }

  async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const result: R[] = new Array(items.length)
    let next = 0
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++
        result[index] = await fn(items[index])
      }
    })
    await Promise.all(workers)
    return result
  }

  function excludePath(rel: string): boolean {
    const normalized = process.platform === "win32" ? rel.replaceAll("\\", "/") : rel
    const segments = normalized.split("/")
    if (segments.some((segment) => EXCLUDED_DIRS.has(segment))) return true
    return EXCLUDED_EXTENSIONS.has(path.extname(normalized).toLowerCase())
  }

  async function ensureExclude(git: string) {
    const info = path.join(git, "info")
    await fs.mkdir(info, { recursive: true })
    const body = [
      "# Synergy snapshot exclusions",
      ...[...EXCLUDED_DIRS].sort().map((dir) => `${dir}/`),
      ...[...EXCLUDED_EXTENSIONS].sort().map((extension) => `*${extension}`),
      "",
    ].join("\n")
    const file = path.join(info, "exclude")
    const current = await fs.readFile(file, "utf8").catch(() => undefined)
    if (current !== body) await Storage.writeJsonAtomic(file, body)
  }

  function absoluteWorktreePath(rel: string): string {
    return path.join(ScopeContext.current.directory, rel)
  }

  function parseNumstatPatch(text: string): {
    stats: Array<{ additions: string; deletions: string; file: string }>
    patches: string[]
  } {
    // Provenance: https://git-scm.com/docs/git-diff (-z and --numstat).
    // NUL-delimited statistics preserve literal names; patch headers are display text.
    const boundary = text.indexOf("\0\0")
    const stats = boundary < 0 ? text : text.slice(0, boundary)
    return {
      stats: stats
        .split("\0")
        .filter(Boolean)
        .map((record) => {
          const first = record.indexOf("\t")
          const second = record.indexOf("\t", first + 1)
          if (first < 0 || second < 0) throw new SnapshotStore.StorageError("Invalid snapshot diff statistics")
          return {
            additions: record.slice(0, first),
            deletions: record.slice(first + 1, second),
            file: record.slice(second + 1),
          }
        }),
      patches: splitPatches(boundary < 0 ? "" : text.slice(boundary + 2)),
    }
  }

  function splitPatches(text: string) {
    if (!text.trim()) return []
    return text
      .split(/^diff --git /m)
      .filter(Boolean)
      .map((patch) => `diff --git ${patch}`)
  }

  function objectSizeKey(tree: string, file: string) {
    return `${tree}:${file}`
  }

  async function objectSizes(
    git: string,
    objects: Array<{ tree: string; file: string }>,
    signal?: AbortSignal,
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>()
    if (objects.length === 0) return result
    const requested = new Set(objects.map((object) => objectSizeKey(object.tree, object.file)))
    // Provenance: https://git-scm.com/docs/git-ls-tree (-l -z).
    // Tree entries carry sizes without interpolating filenames into a line protocol.
    for (const tree of new Set(objects.map((object) => object.tree))) {
      const listing = await gitSpawn(
        ["git", "--git-dir", git, "ls-tree", "-r", "-l", "-z", tree],
        path.dirname(git),
        undefined,
        signal,
      )
      if (listing.exitCode !== 0) throw new SnapshotStore.StorageError("Snapshot tree metadata is unavailable")
      for (const entry of listing.text.split("\0")) {
        if (!entry) continue
        const separator = entry.indexOf("\t")
        const size = entry.slice(0, separator).trim().split(/\s+/)[3]
        const key = objectSizeKey(tree, entry.slice(separator + 1))
        if (requested.has(key) && /^\d+$/.test(size)) result.set(key, Number(size))
      }
    }
    return result
  }

  function gitdir() {
    return SnapshotStore.current().repository
  }
}
